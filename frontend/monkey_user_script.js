// ==UserScript==
// @name     KiPLM integration for Mouser and DigiKey
// @match    https://www.mouser.*/ProductDetail/*
// @match    https://*.mouser.com/ProductDetail/*
// @match    https://*.digikey.com/*
// @version  1.0
// @author   Johannes Bergmann
// @resource jquery https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js
// @grant    GM_xmlhttpRequest
// @grant    GM_getResourceText
// ==/UserScript==

(function () {
    // Make jQuery and priviledged functions available in injected JavaScript
    // unsafeWindow.jquery = $.noConflict(true);
    unsafeWindow.GM_xmlhttpRequest = GM_xmlhttpRequest
    unsafeWindow.GM_getResourceText = GM_getResourceText

    // Inject the JavaScript from the KiPLM API server
    let elem = document.createElement('script')
    elem.src = 'http://localhost:5000/monkey-api/injected_code.js';
    document.body.appendChild(elem);

    // Inject the Font Awesome stylesheet
    elem = document.createElement('link');
    elem.rel = 'stylesheet';
    elem.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.9.0/css/all.min.css';
    document.head.appendChild(elem);
})();
