'use strict';

var requestRedditJsonCache = new Map();
var timeOfLastRealRequest = 0;
var timeInMsBetweenRequests = 2000; // Don't hammer the API

// Attempts to retrieve the given reddit URL in json. For this it appends .json to the url
//  If successful calls successCallback with the JSON object of the page
//  If the request fails errorCallback is called with an error string describing the failure
function requestRedditJSON(url, successCallback, errorCallback)
{
    setTimeout(function() {
        var httpRequest = new XMLHttpRequest();
        httpRequest.onreadystatechange = function () {
            timeOfLastRealRequest = Date.now();
            if (httpRequest.readyState === XMLHttpRequest.DONE) {
                if (httpRequest.status === 200) {
                    console.debug("retrieved " + url);
                    var json = JSON.parse(httpRequest.responseText);
                    successCallback(json);
                }
                else {
                    var err = "Failed to retrieve url '" + url + "' (" + httpRequest.statusText + ")";
                    console.error(err, httpRequest);
                    errorCallback(err);
                }
            }
        };
        httpRequest.open('GET', url + '.json', true); // Retrieve in JSON format for CORS and NSFW compat
        httpRequest.send();
    }, Math.max(0, timeOfLastRealRequest + timeInMsBetweenRequests - Date.now()));
}


// Calls requestRedditJSON and caches its results for future calls if the request succeeds.
function requestRedditJSONCached(url, successCallback, errorCallback)
{
    if (requestRedditJsonCache.has(url)) {
        successCallback(requestRedditJsonCache.get(url));
    } else {
        requestRedditJSON(url, function(json) {
            requestRedditJsonCache.set(url, json);
            successCallback(json);
        }, errorCallback);
    }
}

// Returns true if the given URL was cached by requestRedditJSONCached
function isCached(url) {
    return requestRedditJsonCache.has(url);
}

// Expects a HFY wiki page url and heuristically attempts to extract series information.
//  If successful calls completionCallback with a series object of the structure
//      {title:string, author:string, parts:[part]}
//  If the information collection fails errorCallback is called with a string describing the failure.
function collectSeriesInfoFromWikiPage(url, completionCallback, errorCallback)
{
    requestRedditJSONCached(url, function(json) {
        if (json.kind != "wikipage") errorCallback(url + " is not a wiki page");
        var indexHtml = he.decode(json.data.content_html);

        var parser = new DOMParser();
        var doc = parser.parseFromString(indexHtml, "text/html");

        // Try to guess title
        var title = "";
        var h1 = doc.getElementsByTagName("h1");
        if (h1.length > 0) {
            title = h1[0].textContent;
        } else {
            var h2 = doc.getElementsByTagName("h2");
            if (h2.length > 0) {
                title = h2[0].textContent;
            } else {
                var h3 = doc.getElementsByTagName("h3");
                if (h3.length > 0) {
                    title = h3[0].textContent;
                }
            }
        }

        // Try to find parts
        var parts = [];
        var links = doc.getElementsByTagName("a");
        for (var i = 0; i < links.length; i++) {
            //TODO: Could also try to guess the author name here
            var link = links[i];
            var name = nameFromURL(link.getAttribute('href'));
            if (name) {
                // We assume everything we can get a name for is fair game
                parts.push({
                    name: name,
                    url: link.getAttribute('href'),
                    title: link.textContent
                });
            }
        }

        // Find author information from first part post
        if (parts.length > 0) {
            collectPost(parts[0].url, function(post) {
                completionCallback({
                    title: title == "" ? post.title : title,
                    author: post.author,
                    parts: parts
                });
            },
            errorCallback);
        }
    }, errorCallback);
}

// Given the HTML content of a post and a set of previous reddit post names attempts to
// heuristically find the URL of the next post. It does so by checking each link text
// of the post against a regex it retrieves from a UI input element #nextPostRegex .
// The first match it finds is returned as the next URL. If no match is found null is
// returned.
function findNextURL(content, previousNames) {
    var parser = new DOMParser();
    var regex = new RegExp(document.getElementById("nextPostRegex").value, "i");
    var doc = parser.parseFromString(content, "text/html");
    var links = doc.getElementsByTagName("a");
    for (var i = 0; i < links.length; i++) {
        var link = links[i];
        if (link.textContent.match(regex)) {
            var potentialNextLink = link.getAttribute('href');
            if (!previousNames.includes(nameFromURL(potentialNextLink))) {
                return potentialNextLink;
            }
        }
    }
    return null;
}

// Returns the reddit name for a given url
// The URL may be shortened
function nameFromURL(url)
{
    var match = url.match(/redd\.it\/([A-Za-z0-9]+)/i);
    if (match) {
        return match[1].toLowerCase();
    }
    match = url.match(/r\/HFY\/comments\/([A-Za-z0-9]+)/i);
    if (match) {
        return match[1].toLowerCase();
    }
    return undefined;
}

// Returns the reddit url for a given reddit post name.
// Only works for HFY posts.
function urlFromName(name)
{
    return "https://www.reddit.com/r/HFY/comments/" + name + "/";
}

// Returns true if the given reddit post name was cached by requestRedditJSON already
function isNameCached(name) {
    return isCached(urlFromName(name));
}

// Due to CORS we cannot work with shortened URI. Luckily reddits URL shortener is special
// so as long as we know the subreddit we are working with we can unshorten ourselves.
// This function also normalizes the name to improve caching
function unshorten(url)
{
    return urlFromName(nameFromURL(url));
}

// Given the URL to a reddit HFY post retrieves this function retrieves it.
// - If successful successCallback is called with a post object of the following
//   structure {author:string, title:string, name:string, content:string, url:string}.
//   Where author is the author of the post page, title is the title of the post, name is
//   the reddit name of the post, content is the HTML content of the initial post and url is
//   url of the post.
// - If the collection fails errorCallback is called with a string describing the failure.
function collectPost(url, successCallback, errorCallback)
{
    var unshortenedUrl = unshorten(url);
    requestRedditJSONCached(unshortenedUrl, function(json) {
        var post = json[0]['data']['children'][0]['data']; // Post data
        var content = he.decode(post.selftext_html);
        var collectedPost = {
            author: post.author,
            title: post.title,
            name: post.name,
            content: content,
            url: post.url
        };
        successCallback(collectedPost);
    }, errorCallback);
}

// Given a list of parts of the structure {title:string, url:string} collects
// the posts for each part by calling collectPost for its URL. The given part
// title takes precedence of the title of the collected post.
// The function also takes a dictionary of callbacks.
// - Each time a post is collected callbacks.collectPost will be called with the
//   newly collected post.
// - Once all parts are collected callbacks.done is called with the list of all
//   collected posts.
// - If an error occurs callbacks.error is called with an object of structure
//   {part:part, message:string} identifying the part and which error occurred.
//   Collection is aborted after any error.
//
// If any of the callbacks returns false the collection is aborted.
function collectPartPosts(parts, callbacks)
{
    var posts = [];
    var collectPart = function(i) {
        if (i >= parts.length) {
            if (callbacks.done) {
                if (callbacks.done(posts) === false) return;
            }
        } else {
            var part = parts[i];
            collectPost(part.url, function(post) {
                post.title = part.title; // Take title from listing
                if (callbacks.collectedPost) {
                    if (callbacks.collectedPost(post) === false) return;
                }
                posts.push(post);
                collectPart(i + 1);
            }, function(error) {
                if (callbacks.error) {
                    callbacks.error({message: error, part: part});
                }
            });
        }
    };

    collectPart(0);
}

// Follows a series of posts from a starting post
//
// Callbacks:
//  foundUrl(url)
//  collectedPost(post)
//  error(error)
//  done([post])
//
// Any callback returning false aborts the find operation
function findSeriesParts(startUrl, callbacks) {
    var collectedPosts = [];
    var previousNames = [];
    var collectPostRecurse = function(url) {
        // Retrieve the page
        console.log("collectPostRecurse " + url);
        collectPost(url, function(collectedPost) {
            collectedPosts.push(collectedPost);
            if (callbacks.collectedPost) {
                if (callbacks.collectedPost(collectedPost) === false) return;
            }
            previousNames.push(nameFromURL(url));
            var nextUrl = findNextURL(collectedPost.content, previousNames);
            if (nextUrl) {
                if (callbacks.foundUrl) {
                    if (callbacks.foundUrl(nextUrl) === false) return;
                }
                console.log("scheduling collection of '" + nextUrl + "'");
                collectPostRecurse(nextUrl);
            } else {
                console.log("Collection from " + url + " complete. Found " + collectedPosts.length + " posts in series");
                if (callbacks.done) {
                    if (callbacks.done(collectedPosts) === false) return;
                }
            }
        }, function(error) {
            console.log(error.log);
            console.log(error.request);
            log("Failed at post '" + url + "': " + error.message, "error");
            if (callbacks.error) {
                if (callbacks.error(error) === false) return;
            }
        });
    };
    collectPostRecurse(startUrl);
}

// Creates a new entry in the user visible list of logs.
// Level can be any css class like success, warning or danger that
// should be applied to the log entry.
function log(html, level)
{
    var levelClass = level ? ('list-group-item-' + level) : '';
    var log = document.getElementById("logList");
    log.innerHTML += '<li class="list-group-item ' + levelClass + '">' + html + '</li>';
}

// Return the user provided start URL
function getStartUrl()
{
    return document.getElementById("startUrl").value;
}

// Update the given table row with either "success", "warning" or "danger" state
// removing all other states.
function updateRowState(row, state) {
    row.classList.remove("danger");
    row.classList.remove("warning");
    row.classList.remove("success");

    if (state == "success") row.classList.add("success");
    else if (state == "warning") row.classList.add("warning");
    else if (state == "danger") row.classList.add("danger");
}

// Given a part object of structure {title:string, url:string} creates
// a new row in the #partsrow-table. This is done by copying the
// .partsrow-template row and adjusting its cells accordingly.
function addPartToList(part)
{
    var tbody = document.querySelector("#partsrow-table tbody");

    var template = tbody.querySelector(".partsrow-template");
    var instance = template.cloneNode(true);
    instance.classList.remove("partsrow-template");

    instance.querySelector(".partsrow-title").textContent = part.title;
    var url = instance.querySelector(".partsrow-url");
    url.textContent = part.url;

    var link = instance.querySelector(".partsrow-link a");
    var updateLink = function () {
        updateRowState(instance, isNameCached(nameFromURL(url.textContent)) ? "success" : "none");
        link.setAttribute("href", url.textContent);
    };
    url.addEventListener("input", updateLink);

    var removeBtn = instance.querySelector(".partsrow-remove .partsrow-remove-btn");
    removeBtn.addEventListener("click", function() {
       instance.remove();
    });

    updateLink();

    tbody.appendChild(instance);
}

// Given a part object of structure {title:string, url:string} either
// creates a new row in the #partsrow-table or updates the existing
// one with the given URL.
function addOrUpdatePartInList(part)
{
    var row = getRowForPart(part.url);
    if (!row) {
        addPartToList(part);
    } else {
        row.querySelector(".partsrow-title").textContent = part.title;
        updateRowState(row, isNameCached(nameFromURL(part.url)) ? "success" : "none");
    }
}

// Given the URL of a reddit HFY post returns the corresponding tr DOM element
// in the #partsrow-table. Returns null if no row exists for the URL.
function getRowForPart(url) {
    var name = nameFromURL(url);
    var rows = document.querySelectorAll("#partsrow-table tbody tr:not(.partsrow-template)");
    for (var i = 0; i < rows.length; ++i) {
        var row = rows[i];
        var rowUrl = row.querySelector(".partsrow-url").textContent;
        var rowName = nameFromURL(rowUrl);
        if (name == rowName) {
            return row;
        }
    }
    return null;
}

// Returns a part list of structure [{name:string, title:string, url:string}] with one
// entry for each row of the #partsrow-table.
function getPartsFromList()
{
    var parts = [];
    var rows = document.querySelectorAll("#partsrow-table tbody tr:not(.partsrow-template)");
    for (var i = 0; i < rows.length; ++i) {
        var row = rows[i];
        var title = row.querySelector(".partsrow-title").textContent;
        var url = row.querySelector(".partsrow-url").textContent;

        parts.push({
            name: nameFromURL(url),
            title: title,
            url: url
        });
    }

    return parts;
}

// Removes all entries from the #partsrow-table
function clearPartsFromList() {
    var rows = document.querySelectorAll("#partsrow-table tbody tr:not(.partsrow-template)");
    for (var i = 0; i < rows.length; ++i) {
        var row = rows[i];
        row.remove();
    }
}

// Creates a epub files with the current title, author and parts from the #partsrow-table
// and provides it to the user for download.
function createAndDownloadSeriesAsEpub(event)
{
    event.preventDefault();

    epubMakerBtn.disabled = true;
    var startUrl = getStartUrl();
    var parts = getPartsFromList();
    collectPartPosts(parts, {
        collectedPost: function (post) {
            var row = getRowForPart(post.url);
            if (row) {
                updateRowState(row, isNameCached(nameFromURL(post.url)) ? "success" : "none");
            }
            log("Collected post in series: '" + post.title + "'");
        },
        done: function(posts) {
            log("All " + posts.length + " series parts available. Creating epub.", "success");

            var title = document.querySelector('#seriesTitle').value;
            var author = document.querySelector('#seriesAuthor').value;

            var epubMaker = new EpubMaker()
                .withTemplate('idpf-wasteland')
                .withTitle(title)
                .withAuthor(author)
                .withSection(new EpubMaker.Section('titlepage', 'titlepage', {
                        content: '<div style="text-align: center;">' +
                        '<h1>' + he.encode(title) + '</h1>' +
                        '<h3>by <a href="https://reddit.com/u/' + he.encode(author) + '">' + he.encode(author) + '</a></h3>' +
                        '</div>' +
                        '<div style=”page-break-before:always;”></div>'
                    }, false, true)
                );

            posts.forEach(function (post) {
                epubMaker.withSection(new EpubMaker.Section("chapter", post.name, {
                    content: post.content,
                    title: post.title
                }, true, false))
            });

            epubMakerBtn.disabled = false;
            epubMaker.downloadEpub(function (epubZipContent, filename) {
                epubMakerBtn.href = URL.createObjectURL(epubZipContent);
                epubMakerBtn.download = filename;
                epubMakerBtn.removeEventListener('click', createAndDownloadSeriesAsEpub);
            });
        },
        error: function(error) {
            log("Aborting collection due to failure to collect '" + error.part.title + "': " + error.message, "danger");
            updateRowState(getRowForPart(error.part.url), "danger");
            epubMakerBtn.disabled = false;
        }
    });
}

// Tries to fill the title, author and parts table for the current start URL
function retrieveSeriesInfo(event)
{
    event.preventDefault();
    retrieveInfoBtn.disabled = true;
    clearPartsFromList();
    var startUrl = getStartUrl();
    requestRedditJSONCached(startUrl, function(json) {
        if (json.kind == "wikipage") {
            collectSeriesInfoFromWikiPage(startUrl, function(series) {
                    log("Retrieved series information from '" + startUrl + "'. Referenced " + series.parts.length + " parts.", "success");
                    console.log(series);
                    document.querySelector('#seriesAuthor').value = series.author;
                    document.querySelector('#seriesTitle').value = series.title;

                    series.parts.forEach(function(part) { addPartToList(part); });
                    retrieveInfoBtn.disabled = false;
                },
                function (error) {
                    log("Failed to retrieve series information from '" + startUrl + "'.");
                    console.log(error);
                    retrieveInfoBtn.disabled = false;
                });
        }
        else {
            collectPost(startUrl, function(post) {
                    log("Retrieved author and title from first post. Will now collect posts in series.", "success");
                    document.querySelector('#seriesAuthor').value = post.author;
                    document.querySelector('#seriesTitle').value = post.title;

                    findSeriesParts(startUrl, {
                        foundUrl: function(url) {
                            addPartToList({
                                title: "?",
                                url: url
                            });
                        },
                        collectedPost: function(post) {
                            log("Found post in series: '" + post.title + "'");
                            addOrUpdatePartInList(post);
                        },
                        done: function(posts) {
                            log("Done following series links. Found " + posts.length + " posts", "success");
                            retrieveInfoBtn.disabled = false;
                        },
                        error: function(e) {
                            log("Error while following series links", "danger");
                            console.log(e);
                            retrieveInfoBtn.disabled = false;
                        }
                    });
                },
                function (error) {
                    console.log(error.log);
                    console.log(error.request);
                    log("Failed to retrieve series info (" + error.message + ")", "error");
                    retrieveInfoBtn.disabled = false;
                });
        }
    }, function(error) {
        log("Failed to retrieve given page '" + startUrl + "'.", "danger");
        console.log(error);
        retrieveInfoBtn.disabled = false;
    });
}

var delayBetweenRequestsInput  = document.getElementById("delayBetweenRequests");
delayBetweenRequestsInput.addEventListener('input', function(val) {
   timeInMsBetweenRequests = val * 1000.0;
});

var retrieveInfoForm = document.querySelector('#retrieveInfoForm');
retrieveInfoForm.addEventListener('submit', retrieveSeriesInfo);

Sortable.create(document.querySelector("#partsrow-table tbody"), {
    handle: ".partsrow-draghandle"
});

document.getElementById("partsrow-add-btn").addEventListener("click", function(event) {
    event.preventDefault();
    addPartToList({
        url: "",
        title: ""
    });
});

var epubMakerForm = document.querySelector('#epubMakerForm');
epubMakerForm.addEventListener('submit', createAndDownloadSeriesAsEpub);