/* eslint-env phantomjs */
'use strict';

var fs = require('fs');
// phantom js related
var system = require('system');
var webpage = require('webpage');

// var nonMatchingMediaQueryRemover = require('./non-matching-media-query-remover')

var GENERATION_DONE = 'GENERATION_DONE';

var stdout = system.stdout; // for using this as a file
var page; // initialised in prepareNewPage

var args = system.args;
if (args.length < 4) {
  errorlog('Not enough arguments.');
  phantomExit(1);
}

var criticalCssOptions = {
  url: encodeURI(args[1]),
  ast: args[2],
  width: args[3],
  height: args[4],
  // always forceInclude '*' selector
  forceInclude: [{ value: '*' }].concat(JSON.parse(args[5]) || []),
  userAgent: args[6],
  renderWaitTime: parseInt(args[7], 10),
  blockJSRequests: args[8],
  customPageHeaders: JSON.parse(args[9]) || {},
  debugMode: args[10] === 'true'
};

function debuglog(msg, isError) {
  if (criticalCssOptions.debugMode) {
    system.stderr.write((isError ? 'ERR: ' : '') + msg);
  }
}

// monkey patch for directing errors to stderr
// https://github.com/ariya/phantomjs/issues/10150#issuecomment-28707859
function errorlog(msg) {
  if (criticalCssOptions.debugMode) {
    debuglog(msg, true);
  } else {
    system.stderr.write(msg);
  }
}

function prepareNewPage() {
  debuglog('prepareNewPage');
  page = webpage.create();
  // don't confuse analytics more than necessary when visiting websites
  page.settings.userAgent = criticalCssOptions.userAgent;
  page.customHeaders = criticalCssOptions.customPageHeaders;

  /* prevent page JS errors from being output to final CSS */
  page.onError = function () {
    // do nothing
  };

  page.onConsoleMessage = function (msg) {
    // filter out console messages from the page
    // - the ones sent by penthouse for debugging has 'debug: ' prefix.
    if (/^debug: /.test(msg)) {
      debuglog(msg.replace(/^debug: /, ''));
    }
  };

  page.onResourceRequested = function (requestData, request) {
    if (criticalCssOptions.blockJSRequests !== 'false' && /\.js(\?.*)?$/.test(requestData.url)) {
      request.abort();
    }
  };

  page.onResourceError = function (resourceError) {
    page.reason = resourceError.errorString;
    page.reason_url = resourceError.url; // jshint ignore: line
  };
  page.onCallback = function (callbackObject) {
    if (callbackObject.status === GENERATION_DONE) {
      debuglog('GENERATION_DONE');
      returnCssFromAstRules(callbackObject.rules);
    }
  };
}

function returnCssFromAstRules(criticalRules) {
  debuglog('returnCssFromAstRules');
  try {
    if (criticalRules && criticalRules.length > 0) {
      stdout.write(JSON.stringify(criticalRules));
      debuglog('finalCss: write - DONE!');
      phantomExit(0);
    } else {
      // No css. Warning will be raised later in process.
      // for consisteny, still generate output (will be empty)
      stdout.write([JSON.stringify([])]);
      phantomExit(0);
    }
  } catch (ex) {
    errorlog('error in returnCssFromAstRules: ' + ex);
    phantomExit(1);
  }
}

// discard stdout from phantom exit
function phantomExit(code) {
  if (page) {
    page.close();
  }
  setTimeout(function () {
    phantom.exit(code);
  }, 0);
}

// called inside a sandboxed environment inside phantomjs - no outside references
// arguments and return value must be primitives
// @see http://phantomjs.org/api/webpage/method/evaluate.html
function pruneNonCriticalCss(astRules, forceInclude, renderWaitTime, doneStatus) {
  console.log('debug: pruneNonCriticalCss');
  var h = window.innerHeight;

  var psuedoSelectorsToKeep = [':before', ':after', ':visited', ':first-letter', ':first-line'];
  // detect these selectors regardless of whether one or two semi-colons are used
  var psuedoSelectorsToKeepRegex = psuedoSelectorsToKeep.map(function (s) {
    return ':?' + s;
  }).join('|'); // separate in regular expression
  // we will replace all instances of these psuedo selectors; hence global flag
  var PSUEDO_SELECTOR_REGEXP = new RegExp(psuedoSelectorsToKeepRegex, 'g');

  var isElementAboveFold = function isElementAboveFold(element) {
    // temporarily force clear none in order to catch elements that clear previous content themselves and who w/o their styles could show up unstyled in above the fold content (if they rely on f.e. 'clear:both;' to clear some main content)
    var originalClearStyle = element.style.clear || '';
    element.style.clear = 'none';
    var aboveFold = element.getBoundingClientRect().top < h;

    // set clear style back to what it was
    element.style.clear = originalClearStyle;

    if (!aboveFold) {
      // phantomJS/QT browser has some bugs regarding fixed position;
      // sometimes positioning elements outside of screen incorrectly.
      // just keep all fixed position elements - normally very few in a stylesheet anyway
      var styles = window.getComputedStyle(element, null);
      if (styles.position === 'fixed') {
        console.log('debug: force keeping fixed position styles');
        return true;
      }
    }
    return aboveFold;
  };

  var matchesForceInclude = function matchesForceInclude(selector) {
    return forceInclude.some(function (includeSelector) {
      if (includeSelector.type === 'RegExp') {
        var pattern = new RegExp(includeSelector.value);
        return pattern.test(selector);
      }
      return includeSelector.value === selector;
    });
  };

  var isSelectorCritical = function isSelectorCritical(selector) {
    if (matchesForceInclude(selector.trim())) {
      return true;
    }

    // Case 3: @-rule with full CSS (rules) inside [REMAIN]
    // @viewport, @-ms-viewport. AST parser classifies these as "regular" rules
    if (/^@/.test(selector)) {
      return true;
    }

    // some selectors can't be matched on page.
    // In these cases we test a slightly modified selectors instead, modifiedSelector.
    var modifiedSelector = selector;
    if (modifiedSelector.indexOf(':') > -1) {
      // handle special case selectors, the ones that contain a semi colon (:)
      // many of these selectors can't be matched to anything on page via JS,
      // but that still might affect the above the fold styling

      // these psuedo selectors depend on an element, so test element instead
      // (:hover, :focus, :active would be treated same
      // IF we wanted to keep them for critical path css, but we don't)
      modifiedSelector = modifiedSelector.replace(PSUEDO_SELECTOR_REGEXP, '');

      // if selector is purely psuedo (f.e. ::-moz-placeholder), just keep as is.
      // we can't match it to anything on page, but it can impact above the fold styles
      if (modifiedSelector.replace(/:[:]?([a-zA-Z0-9\-_])*/g, '').trim().length === 0) {
        return true;
      }

      // handle browser specific psuedo selectors bound to elements,
      // Example, button::-moz-focus-inner, input[type=number]::-webkit-inner-spin-button
      // remove browser specific pseudo and test for element
      modifiedSelector = modifiedSelector.replace(/:?:-[a-z-]*/g, '');
    }

    // now we have a selector to test, first grab any matching elements
    var elements;
    try {
      elements = document.querySelectorAll(modifiedSelector);
    } catch (e) {
      // not a valid selector, remove it.
      return false;
    }

    // some is not supported on Arrays in this version of QT browser,
    // meaning have to write much less terse code here.
    var elementIndex = 0;
    var aboveFold = false;
    while (!aboveFold && elementIndex < elements.length) {
      aboveFold = isElementAboveFold(elements[elementIndex]);
      elementIndex++;
    }
    return aboveFold;
  };

  var isCssRuleCritical = function isCssRuleCritical(rule) {
    if (rule.type === 'rule') {
      // check what, if any selectors are found above fold
      rule.selectors = rule.selectors.filter(isSelectorCritical);
      return rule.selectors.length > 0;
    }
    /* ==@-rule handling== */
    /* - Case 0 : Non nested @-rule [REMAIN]
     (@charset, @import, @namespace)
     */
    if (rule.type === 'charset' || rule.type === 'import' || rule.type === 'namespace') {
      return true;
    }

    /* Case 1: @-rule with CSS properties inside [REMAIN]
      @font-face, @keyframes - keep here, but remove later in code, unless it is used.
    */
    if (rule.type === 'font-face' || rule.type === 'keyframes') {
      return true;
    }

    /* Case 3: @-rule with full CSS (rules) inside [REMAIN]
    */
    if (
    // non matching media queries are stripped out in non-matching-media-query-remover.js
    rule.type === 'media' || rule.type === 'document' || rule.type === 'supports') {
      rule.rules = rule.rules.filter(isCssRuleCritical);
      return rule.rules.length > 0;
    }

    return false;
  };

  var processCssRules = function processCssRules() {
    console.log('debug: processCssRules BEFORE');
    var criticalRules = astRules.filter(isCssRuleCritical);
    console.log('debug: processCssRules AFTER');

    // we're done - call final function to exit outside of phantom evaluate scope
    window.callPhantom({
      status: doneStatus,
      rules: criticalRules
    });
  };

  // give some time (renderWaitTime) for sites like facebook that build their page dynamically,
  // otherwise we can miss some selectors (and therefor rules)
  // --tradeoff here: if site is too slow with dynamic content,
  // it doesn't deserve to be in critical path.
  setTimeout(processCssRules, renderWaitTime);
}

/*
 * Tests each selector in css file at specified resolution,
 * to see if any such elements appears above the fold on the page
 * calls callPhantom when done, with an updated AST rules list
 *
 * @param options.url the url as a string
 * @param options.ast the css as an AST object
 * @param options.width the width of viewport
 * @param options.height the height of viewport
 --------------------------------------------------------- */
function getCriticalPathCss(options) {
  debuglog('getCriticalPathCss');
  prepareNewPage();
  page.viewportSize = {
    width: options.width,
    height: options.height
  };

  /*
    Media query removal disabled because it can cause non-media query rules
    from mobile to overwrite media query rules for desktop.
    After combineCSS (combine desktop + mobile) is called by Critical you
    end up with something like this:
    // From desktop
    .container{} // empty because it's duplicate
    @media wide {.container{ width: "70%" } }
    // From mobile
    .container{ width: "100%"}
    // => mobile .container overrides media query!
  */
  var astRules = options.ast.stylesheet.rules;
  // // first strip out non matching media queries
  // var astRules = nonMatchingMediaQueryRemover(
  //   options.ast.stylesheet.rules,
  //   options.width,
  //   options.height
  // )
  debuglog('stripped out non matching media queries');

  page.open(options.url, function (status) {
    if (status === 'success') {
      debuglog('page opened');
      page.evaluate(pruneNonCriticalCss, astRules, options.forceInclude, options.renderWaitTime, GENERATION_DONE);
    } else {
      errorlog("Error opening url '" + page.reason_url + "': " + page.reason); // jshint ignore: line
      phantomExit(1);
    }
  });
}

debuglog('Penthouse core start');
var ast;
try {
  var f = fs.open(criticalCssOptions.ast, 'r');
  ast = f.read();
  debuglog('opened ast from file');
  ast = JSON.parse(ast);
  debuglog('parsed ast from json');
} catch (e) {
  errorlog(e);
  phantomExit(1);
}

criticalCssOptions.ast = ast;
getCriticalPathCss(criticalCssOptions);