/* global getStyleWithNoCode, applyOnMessage, onBackgroundMessage, getStyles */
'use strict';

// keep message channel open for sendResponse in chrome.runtime.onMessage listener
const KEEP_CHANNEL_OPEN = true;
const FIREFOX = /Firefox/.test(navigator.userAgent);
const OPERA = /OPR/.test(navigator.userAgent);
const URLS = {
  ownOrigin: chrome.runtime.getURL(''),
  optionsUI: new Set([
    chrome.runtime.getURL('options/index.html'),
    'chrome://extensions/?options=' + chrome.runtime.id,
  ]),
  configureCommands: OPERA ? 'opera://settings/configureCommands'
    : 'chrome://extensions/configureCommands',
};
const RX_SUPPORTED_URLS = new RegExp(`^(file|https?|ftps?):|^${URLS.ownOrigin}`);

document.documentElement.classList.toggle('firefox', FIREFOX);
document.documentElement.classList.toggle('opera', OPERA);


function notifyAllTabs(request) {
  // list all tabs including chrome-extension:// which can be ours
  if (request.codeIsUpdated === false && request.style) {
    request = Object.assign({}, request, {
      style: getStyleWithNoCode(request.style)
    });
  }
  const affectsAll = !request.affects || request.affects.all;
  const affectsOwnOrigin = !affectsAll && (request.affects.editor || request.affects.manager);
  const affectsTabs = affectsAll || affectsOwnOrigin;
  const affectsIcon = affectsAll || request.affects.icon;
  const affectsPopup = affectsAll || request.affects.popup;
  if (affectsTabs || affectsIcon) {
    chrome.tabs.query(affectsOwnOrigin ? {url: URLS.ownOrigin + '*'} : {}, tabs => {
      for (const tab of tabs) {
        if (affectsTabs || URLS.optionsUI.has(tab.url)) {
          chrome.tabs.sendMessage(tab.id, request);
        }
        if (affectsIcon) {
          updateIcon(tab);
        }
      }
    });
  }
  // notify self: the message no longer is sent to the origin in new Chrome
  if (window.applyOnMessage) {
    applyOnMessage(request);
  } else if (window.onBackgroundMessage) {
    onBackgroundMessage(request);
  }
  // notify background page and all open popups
  if (affectsPopup || request.prefs) {
    chrome.runtime.sendMessage(request);
  }
}


function refreshAllTabs() {
  return new Promise(resolve => {
    // list all tabs including chrome-extension:// which can be ours
    chrome.tabs.query({}, tabs => {
      const lastTab = tabs[tabs.length - 1];
      for (const tab of tabs) {
        getStyles({matchUrl: tab.url, enabled: true, asHash: true}, styles => {
          const message = {method: 'styleReplaceAll', styles};
          if (tab.url == location.href && typeof applyOnMessage !== 'undefined') {
            applyOnMessage(message);
          } else {
            chrome.tabs.sendMessage(tab.id, message);
          }
          updateIcon(tab, styles);
          if (tab == lastTab) {
            resolve();
          }
        });
      }
    });
  });
}


function updateIcon(tab, styles) {
  // while NTP is still loading only process the request for its main frame with a real url
  // (but when it's loaded we should process style toggle requests from popups, for example)
  const isNTP = tab.url == 'chrome://newtab/';
  if (isNTP && tab.status != 'complete' || tab.id < 0) {
    return;
  }
  if (styles) {
    // check for not-yet-existing tabs e.g. omnibox instant search
    chrome.tabs.get(tab.id, () => {
      if (!chrome.runtime.lastError) {
        stylesReceived(styles);
      }
    });
    return;
  }
  (isNTP ? getTabRealURL(tab) : Promise.resolve(tab.url))
    .then(url => getStylesSafe({
      matchUrl: url,
      enabled: true,
      asHash: true,
    }))
    .then(stylesReceived);

  function stylesReceived(styles) {
    let numStyles = styles.length;
    if (numStyles === undefined) {
      // for 'styles' asHash:true fake the length by counting numeric ids manually
      numStyles = 0;
      for (const id of Object.keys(styles)) {
        numStyles += id.match(/^\d+$/) ? 1 : 0;
      }
    }
    const disableAll = 'disableAll' in styles ? styles.disableAll : prefs.get('disableAll');
    const postfix = disableAll ? 'x' : numStyles == 0 ? 'w' : '';
    const color = prefs.get(disableAll ? 'badgeDisabled' : 'badgeNormal');
    const text = prefs.get('show-badge') && numStyles ? String(numStyles) : '';
    chrome.browserAction.setIcon({
      tabId: tab.id,
      path: {
        // Material Design 2016 new size is 16px
        16: `images/icon/16${postfix}.png`,
        32: `images/icon/32${postfix}.png`,
        // Chromium forks or non-chromium browsers may still use the traditional 19px
        19: `images/icon/19${postfix}.png`,
        38: `images/icon/38${postfix}.png`,
        // TODO: add Edge preferred sizes: 20, 25, 30, 40
      },
    }, ignoreChromeError);
    // Vivaldi bug workaround: setBadgeText must follow setBadgeBackgroundColor
    chrome.browserAction.setBadgeBackgroundColor({color});
    chrome.browserAction.setBadgeText({text, tabId: tab.id});
  }
}


function getActiveTab() {
  return new Promise(resolve =>
    chrome.tabs.query({currentWindow: true, active: true}, tabs =>
      resolve(tabs[0])));
}


function getActiveTabRealURL() {
  return getActiveTab()
    .then(getTabRealURL);
}


function getTabRealURL(tab) {
  return new Promise(resolve => {
    if (tab.url != 'chrome://newtab/') {
      resolve(tab.url);
    } else {
      chrome.webNavigation.getFrame({tabId: tab.id, frameId: 0, processId: -1}, frame => {
        resolve(frame && frame.url || '');
      });
    }
  });
}


// opens a tab or activates the already opened one,
// reuses the New Tab page if it's focused now
function openURL({url, currentWindow = true}) {
  if (!url.includes('://')) {
    url = chrome.runtime.getURL(url);
  }
  return new Promise(resolve => {
    // [some] chromium forks don't handle their fake branded protocols
    url = url.replace(/^(opera|vivaldi)/, 'chrome');
    // API doesn't handle the hash-fragment part
    chrome.tabs.query({url: url.replace(/#.*/, ''), currentWindow}, tabs => {
      for (const tab of tabs) {
        if (tab.url == url) {
          activateTab(tab).then(resolve);
          return;
        }
      }
      getActiveTab().then(tab => {
        if (tab && tab.url == 'chrome://newtab/') {
          chrome.tabs.update({url}, resolve);
        } else {
          chrome.tabs.create(tab && !FIREFOX ? {url, openerTabId: tab.id} : {url}, resolve);
        }
      });
    });
  });
}


function activateTab(tab) {
  return Promise.all([
    new Promise(resolve => {
      chrome.tabs.update(tab.id, {active: true}, resolve);
    }),
    new Promise(resolve => {
      chrome.windows.update(tab.windowId, {focused: true}, resolve);
    }),
  ]);
}


function stringAsRegExp(s, flags) {
  return new RegExp(s.replace(/[{}()[\]/\\.+?^$:=*!|]/g, '\\$&'), flags);
}


// expands * as .*?
function wildcardAsRegExp(s, flags) {
  return new RegExp(s.replace(/[{}()[\]/\\.+?^$:=!|]/g, '\\$&').replace(/\*/g, '.*?'), flags);
}


function ignoreChromeError() {
  chrome.runtime.lastError; // eslint-disable-line no-unused-expressions
}
