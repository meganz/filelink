/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* This file implements the nsIMsgCloudFileProvider interface.
 *
 * This component handles the MEGA implementation of the
 * nsIMsgCloudFileProvider interface.
 */

const Cu = Components.utils;
const Cr = Components.results;
const Cc = Components.classes;
const Ci = Components.interfaces;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/AddonManager.jsm");
Cu.import("resource:///modules/cloudFileAccounts.js");

let kDebug = !1;
const kMaxFileSize = Math.pow(2,32) - 1;
const kAuthSecretRealm = "MEGA Auth Secret";
const kAddonID = 'thunderbird-filelink@mega.nz';

function LOG() {
	if (kDebug) ERR.apply(this, arguments);
};

function ERR() {
	let stack = "\n" + new Error().stack.split("\n")
		.map(s => s.replace(/^(.*@).+\//,'$1')).join("\n");
	let args = [].slice.call(arguments);
	args.unshift(new Date().toISOString());
	Cu.reportError(args.join(" ") + stack);
}
const console = {
	log : function mConsoleLog() {
		LOG([].slice.call(arguments).join(" "));
	},
	error : function mConsoleError() {
		ERR([].slice.call(arguments).join(" "));
	}
};

(function(global) {
	global.loadSubScript = function(file, scope) {
		Services.scriptloader.loadSubScript(file, scope || global);
	};
})(this);

const M = {
	d : kDebug,
	console : console,
	localStorage : {},
	clearTimeout : function mClearTimeout(t) {
		if (t)
			t.cancel();
	},
	setTimeout : function mSetTimeout(f, n) {
		let args = [].slice.call(arguments, 2);
		function Call() {
			try {
				f.apply(this, args);
			} catch (e) {
				ERR(e);
			}
		}
		let i = Ci.nsITimer, t = Cc["@mozilla.org/timer;1"].createInstance(i);
		t.initWithCallback({notify:Call}, n || 30, i.TYPE_ONE_SHOT);
		return t;
	}
};
['sjcl', 'asmcrypto', 'user', 'crypto'].forEach(function (file) {
	try {
		loadSubScript('chrome://mega-filelink/content/core/' + file + '.js', M);
	} catch (e) {
		ERR(e);
	}
});

let iUninstallListener;
function nsMEGA() {
	try {
		if (iUninstallListener) {
			gWindowListener.unregister();
			AddonManager.removeAddonListener(iUninstallListener);
		}
		let self = this;
		iUninstallListener = {
			onUninstalling: function onUninstalled(aAddon) {
				if (aAddon.id === kAddonID) {
					AddonManager.removeAddonListener(iUninstallListener);
					self._killSession(function ksUninstall() {
						LOG('Session killed on uninstall.');
					});
				}
			}
		};
		gWindowListener.register();
		AddonManager.addAddonListener(iUninstallListener);
	} catch(e) {
		ERR(e);
	}
	this._uploads = [];
	this._uploader = null;
	this._uploadingFile = null;
}
nsMEGA.prototype = {
	QueryInterface : XPCOMUtils.generateQI([Ci.nsIMsgCloudFileProvider,Ci.nsIWritablePropertyBag]),

	classID : Components.ID("{3857A119-990E-43B3-A7E5-92132D13FCC0}"),

	get type()           { return "MEGA" },
	get displayName()    { return "MEGA" },
	get serviceURL()     { return "https://mega.nz/" },
	get iconClass()      { return "chrome://mega-filelink/content/logo16.png" },
	get accountKey()     { return this._accountKey },
	get lastError()      { return this._lastErrorText },
	get settingsURL()    { return "chrome://mega-filelink/content/settings.xhtml" },
	get managementURL()  { return "chrome://mega-filelink/content/management.xhtml" },

	_accountKey : false,
	_prefBranch : null,
	_loggedIn : false,
	_userInfo : null,
	_lastErrorStatus : 0,
	_lastErrorText : "",
	_maxFileSize : kMaxFileSize,
	_totalStorage : -1,
	_fileSpaceUsed : -1,
	_urlsForFiles : {},
	_properties : {},

	/**
	 * If we don't know the limit, this will return -1.
	 */
	get fileSpaceUsed() { return this._fileSpaceUsed },
	get fileUploadSizeLimit() { return this._maxFileSize },
	get remainingFileSpace() { return this._totalStorage - this._fileSpaceUsed },

	/**
	 * nsIWritablePropertyBag Implementation
	 */
	setProperty: function nsMEGA_setProperty(aName, aValue) {
		this._properties[aName] = aValue;
	},
	getProperty: function nsMEGA_getProperty(aName) {
		return this._properties[aName];
	},

	/**
	 * Initialize this instance of nsMEGA, setting the accountKey.
	 *
	 * @param aAccountKey the account key to initialize this provider with
	 */
	init : function nsMEGA_init(aAccountKey) {
		this._accountKey = aAccountKey;
		this._prefBranch = Services.prefs
			.getBranch("mail.cloud_files.accounts." + aAccountKey + ".");
		this._userName = this._prefBranch.getCharPref("username");
		// Bug 1240406, displayName might not get set
		if (!this._prefBranch.getPrefType('displayName')) {
			this._prefBranch.setCharPref('displayName', this.displayName);
		}
	},

	/**
	 * The callback passed to an nsMEGAFileUploader, which is fired when
	 * nsMEGAFileUploader exits.
	 *
	 * @param aRequestObserver the request observer originally passed to
	 *                         uploadFile for the file associated with the
	 *                         nsMEGAFileUploader
	 * @param aStatus the result of the upload
	 */
	_uploaderCallback : function nsMEGA__uploaderCallback(aRequestObserver,aStatus) {
		this._removeProgressMeter(this._uploads.shift().transfered|0,
			this._uploadingFile.fileSize);
		this._uploader = null;
		this._uploadingFile = null;
		try {// Bug 1140687
			aRequestObserver.onStopRequest(null, null, aStatus);
		} catch(e) { ERR(e); }
		if (this._uploads.length > 0) {
			let nextUpload = this._uploads[0];
			LOG("chaining upload, file = " + nextUpload.file.leafName);
			this._uploadingFile = nextUpload.file;
			this._uploader = nextUpload;
			try {
				this._logonAndUploadFile(nextUpload.file, nextUpload.requestObserver);
			} catch (ex) {
				nextUpload.callback(Cr.NS_ERROR_FAILURE);
			}
		}
	},

	/**
	 * Attempts to upload a file to MEGA.
	 *
	 * @param aFile the nsILocalFile to be uploaded
	 * @param aCallback an nsIRequestObserver for listening for the starting
	 *                  and ending states of the upload.
	 */
	uploadFile : function nsMEGA_uploadFile(aFile, aCallback) {
		if (Services.io.offline)
			throw Ci.nsIMsgCloudFileProvider.offlineErr;

		let fileName = aFile.leafName;
		if (typeof gSTempStorage[aFile.path] === 'string') {
			fileName = gSTempStorage[aFile.path];
			delete gSTempStorage[aFile.path];
		}
		LOG("UPLOAD REQUEST FOR " + aFile.path + ' (' + fileName + ')');

		// Add progress meter
		try {
			this._addProgressMeter();
			if (this._pmObj) {
				this._pmObj.total += aFile.fileSize;
				this._meterValue = 0;
			}
		} catch(e) {
			ERR(e);
		}

		let uploader = new nsMEGAFileUploader(this, aFile,
				this._uploaderCallback.bind(this, aCallback),
				aCallback, fileName);
		this._uploads.push(uploader);

		// if we're not uploading a file, log-in & upload.
		if (!this._uploadingFile) {
			this._logonAndUploadFile(aFile, aCallback);
		}
	},

	/**
	 * A private function used to ensure that we are logged-in before
	 * attempting to upload a file.
	 *
	 * @param aFile the nsILocalFile to upload
	 * @param aCallback an nsIRequestObserver for monitoring the starting and
	 *                  ending states of the upload.
	 */
	_logonAndUploadFile: function nsMEGA__doUploadFile(aFile, aCallback) {
		if (Services.io.offline)
			throw Ci.nsIMsgCloudFileProvider.offlineErr;

		this._uploadingFile = aFile;

		// Some ugliness here - we stash requestObserver here, because we might
		// use it again in _getUserInfo.
		this.requestObserver = aCallback;

		let successCallback = function __lauSuccess() {
			let result = this._launchUpload(aFile, aCallback);
			if (Cr.NS_OK !== result) {
				failureCallback(result);
			}
		}.bind(this);
		let failureCallback = function __lauFailure(aStatus) {
			this._uploaderCallback(aCallback,
				aStatus || Ci.nsIMsgCloudFileProvider.authErr);
		}.bind(this);
		if (!this._loggedIn)
			return this._logonAndGetUserInfo(successCallback, failureCallback, true);
		if (!this._userInfo)
			return this._getUserInfo(successCallback, failureCallback);
		successCallback();
	},

	/**
	 * A private function used to ensure that we can actually upload the file
	 * (we haven't exceeded file size or quota limitations), and then attempts
	 * to kick-off the upload.
	 *
	 * @param aFile the nsILocalFile to upload
	 * @param aCallback an nsIRequestObserver for monitoring the starting and
	 *                  ending states of the upload.
	 */
	_launchUpload : function nsMEGA__launchUpload(aFile, aCallback) {
		if (!aFile.fileSize || aFile.fileSize > this._maxFileSize)
			return Ci.nsIMsgCloudFileProvider.uploadExceedsFileLimit;
		if (aFile.fileSize > this.remainingFileSpace)
			return Ci.nsIMsgCloudFileProvider.uploadWouldExceedQuota;

		delete this._userInfo; // force us to update userInfo on every upload.

		if (!this._uploader) {
			this._uploader = this._uploads[0];
		}

		this._uploadingFile = aFile;
		this._uploader.uploadFile();

		return Cr.NS_OK;
	},

	/**
	 * Attempts to cancel a file upload.
	 *
	 * @param aFile the nsILocalFile to cancel the upload for.
	 */
	cancelFileUpload : function nsMEGA_cancelFileUpload(aFile) {
		LOG('cancelFileUpload ' + aFile.path);
		if (this._uploadingFile.equals(aFile)) {
			this._uploader.cancel();
		} else {
			for (let i = 0; i < this._uploads.length; i++) {
				let u = this._uploads[i];
				if (u.file.equals(aFile)) {
					u.requestObserver.onStopRequest(
						null, null, Ci.nsIMsgCloudFileProvider.uploadCanceled);
					this._removeProgressMeter(u.transfered|0, u.file.fileSize);
					this._uploads.splice(i, 1);
					break;
				}
			}
		}
	},

	/**
	 * Removes a entry from the SQLite Database.
	 *
	 * @param aKey    The database column name
	 * @param aValue  The row entry to search for
	 */
	_deleteDatabaseEntry: function nsMEGA__deleteDatabaseEntry(aKey, aValue) {
		if (this.db) {
			let stm = this.db.createAsyncStatement("DELETE FROM ftou WHERE " + aKey + " = :" + aKey);
			stm.params[aKey] = aValue;
			try {
				stm.executeAsync({
					handleError : ERR,
					handleResult : ERR,
					handleCompletion : function onDBCompletion(aResult) {
						LOG('DB entry removed, ' + aResult);
					}
				});
			} finally {
				stm.finalize();
			}
		}
	},

	/**
	 * Retrieves a entry from the SQLite Database.
	 *
	 * @param aKey    The database column name
	 * @param aValue  The row entry to search for
	 */
	_getDatabaseEntry: function nsMEGA__getDatabaseEntry(aKey, aValue) {
		let entry;
		if (this.db) {
			let stm = this.db.createStatement("SELECT * FROM ftou WHERE " + aKey + " = :" + aKey + " LIMIT 1");
			stm.params[aKey] = aValue;
			try {
				while (stm.step()) {
					let row = stm.row;
					entry = {
						time: row.time,
						file: row.file,
						link: row.link,
						node: row.node,
						hash: row.hash
					};
					LOG('Got DB entry ' + entry.node + ': ' + entry.link);
				}
			} catch (e) {
				ERR(e);
			} finally {
				stm.reset();
				stm.finalize();
			}
		}
		return entry;
	},

	/**
	 * Store the shared link associated with a local file.
	 *
	 * @param aFile  The nsILocalFile the url belongs to
	 * @param aLink  The URL to store for the file
	 * @param aHandle The handle for the uploaded file
	 * @param aHash The checksum for the file
	 */
	_setSharedURL : function nsMEGA__setSharedURL(aFile, aLink, aHandle, aHash) {
		this._urlsForFiles[aFile.path] = aLink;
		if (aHandle && this.db)
			try {
				let stm = this.db.createAsyncStatement(
						'INSERT INTO ftou (time, file, link, node, hash) ' +
						'VALUES           (:time, :file, :link, :node, :hash)');

				stm.params.time = aFile.lastModifiedTime;
				stm.params.file = aFile.path;
				stm.params.link = aLink;
				stm.params.node = aHandle;
				stm.params.hash = aHash || "";

				try {
					stm.executeAsync({
						handleError : ERR,
						handleResult : ERR,
						handleCompletion : function onDBCompletion(aResult) {
							LOG('DB transaction finished, ' + aResult);
						}
					});
				}
				finally {
					stm.finalize();
				}
			} catch (e) {
				ERR(e);
			}
	},

	/**
	 * A private function used to retrieve the profile information for the
	 * user account associated with the accountKey.
	 *
	 * @param successCallback the function called if information retrieval
	 *                        is successful
	 * @param failureCallback the function called if information retrieval fails
	 */
	_getUserInfo : function nsMEGA__getUserInfo(successCallback,failureCallback) {
		// LOG('_getUserInfo')
		if (!successCallback)
			successCallback = function () {
				this.requestObserver
				.onStopRequest(null, null,
					this._loggedIn ? Cr.NS_OK : Ci.nsIMsgCloudFileProvider.authErr);
			}.bind(this);

		if (!failureCallback)
			failureCallback = function () {
				this.requestObserver
				.onStopRequest(null, null, Ci.nsIMsgCloudFileProvider.authErr);
			}.bind(this);

		M.api_req({a : 'uq', strg : 1, xfer : 1},
		{
			callback : function uq_handler(res) {
				if (typeof res === 'object') {
					this._userInfo = res;
					this.setProperty('cstrgn', res.cstrgn);
					this.setProperty('account', this._userName);
					this._totalStorage = Math.round(res.mstrg);
					this._fileSpaceUsed = Math.round(res.cstrg);
					successCallback();
				} else {
					failureCallback();
				}
			}.bind(this)
		});
	},

	/**
	 * A private function that first ensures that the user is logged in, and then
	 * retrieves the user's profile information.
	 *
	 * @param aSuccessCallback the function called on successful information
	 *                         retrieval
	 * @param aFailureCallback the function called on failed information retrieval
	 * @param aWithUI a boolean for whether or not we should display authorization
	 *                UI if we don't have a valid token anymore, or just fail out.
	 */
	_logonAndGetUserInfo : function nsMEGA_logonAndGetUserInfo(aSuccessCallback,
		aFailureCallback,
		aWithUI) {
		// LOG('_logonAndGetUserInfo')
		if (!aFailureCallback)
			aFailureCallback = function () {
				this.requestObserver
				.onStopRequest(null, null, Ci.nsIMsgCloudFileProvider.authErr);
			}.bind(this);

		let logon = this.logon.bind(this,
			this._getUserInfo.bind(this,aSuccessCallback, aFailureCallback),
				aFailureCallback, aWithUI);

		if (M._userAgent) return logon();

		try {
			M._userAgent = Cc["@mozilla.org/network/protocol;1?name=http"]
				.getService(Ci.nsIHttpProtocolHandler).userAgent;
			AddonManager.getAddonByID(kAddonID,function(data) {
				Object.defineProperty(M,'addonName', {value:data.name});
				Object.defineProperty(M,'addonShortName', {value:String(data.name).split(' ')[0]});
				M._userAgent = String(M._userAgent).replace('Mozilla/5.0', M.addonShortName+'/'+data.version);
				kDebug = String(data.version).replace(/[\d.]/g,'') === 'a';
				LOG(M._userAgent);
				logon();
			});
		} catch(e) {
			ERR(e);
			logon();
		}
	},

	/**
	 * For some nsILocalFile, return the associated sharing URL.
	 *
	 * @param aFile the nsILocalFile to retrieve the URL for
	 */
	urlForFile : function nsMEGA_urlForFile(aFile) {
		LOG('urlForFile ' + aFile.path + ', ' + this._urlsForFiles[aFile.path]);
		return this._urlsForFiles[aFile.path];
	},

	/**
	 * Updates the profile information for the account associated with the
	 * account key.
	 *
	 * @param aWithUI a boolean for whether or not we should display authorization
	 *                UI if we don't have a valid token anymore, or just fail out.
	 * @param aRequest an nsIRequestObserver for observing the starting and
	 *                  ending states of the request.
	 */
	refreshUserInfo : function nsMEGA_refreshUserInfo(aWithUI, aRequest) {
		LOG('refreshUserInfo: ' + this._loggedIn)
		if (Services.io.offline)
			throw Ci.nsIMsgCloudFileProvider.offlineErr;
		this.requestObserver = aRequest;
		aRequest.onStartRequest(null, null);
		if (!this._loggedIn)
			return this._logonAndGetUserInfo(null, null, aWithUI);
		if (!this._userInfo)
			return this._getUserInfo();
		return this._userInfo;
	},

	/**
	 * Our MEGA implementation does not implement the createNewAccount
	 * function defined in nsIMsgCloudFileProvider.idl.
	 */
	createNewAccount : function nsMEGA_createNewAccount(aEmailAddress,
		aPassword, aFirstName,aLastName) {
		return Cr.NS_ERROR_NOT_IMPLEMENTED;
	},

	/**
	 * Attempts to communicate with the service provider in order to get the
	 * proper credentials for starting uploads.
	 *
	 * @param aRequestObserver  The nsIRequestObserver for monitoring the start
	 *                          and stop states of the creation operation.
	 */
	createExistingAccount : function nsMEGA_createExistingAccount(aRequestObserver) {
		let callback = function createExistingAccount_Callback(aResult, aWindow) {
			try {
				aRequestObserver.onStopRequest(null, this, aResult);
			}
			catch (e) {
				if (e.result === Cr.NS_NOINTERFACE) {
					LOG('Got Bug 1240406: ' + e.message);

					if (aWindow && aResult === Cr.NS_OK) {

						try {
							aWindow.arguments[0].accountKey = this.accountKey;
							aWindow.close();
							return;
						}
						catch (e) {}
					}
				}
				var message =
					'Sorry, we were unable to complete the account setup, '
					+ 'please close the dialog and try again.\n\n'
					+ 'Exception thrown:\n\n' + String(e);

				ERR(e);
				Services.prompt.alert(null, this.displayName, message);
			}
		};

		let successCb = callback.bind(this, Cr.NS_OK);
		let failureCb = callback.bind(this, Ci.nsIMsgCloudFileProvider.authErr);

		this.logon(successCb, failureCb, true);
	},

	/**
	 * If the provider doesn't have an API for creating an account, perhaps
	 * there's a url we can load in a content tab that will allow the user
	 * to create an account.
	 */
	get createNewAccountUrl() { return "" },

	/**
	 * For a particular error, return a URL if MEGA has a page for handling
	 * that particular error.
	 *
	 * @param aError the error to get the URL for
	 */
	providerUrlForError : function nsMEGA_providerUrlForError(aError) {
		if (aError == Ci.nsIMsgCloudFileProvider.uploadWouldExceedQuota)
			return this.serviceURL + "#pro";
		return "";
	},

	/**
	 * Attempt to delete an upload file if we've uploaded it.
	 *
	 * @param aFile the file that was originall uploaded
	 * @param aCallback an nsIRequestObserver for monitoring the starting and
	 *                  ending states of the deletion request.
	 */
	deleteFile : function nsMEGA_deleteFile(aFile, aCallback) {
		LOG('deleteFile', aFile.path);
		if (Services.io.offline)
			throw Ci.nsIMsgCloudFileProvider.offlineErr;

		try {
			let dbe = this._getDatabaseEntry('file', aFile.path);
			if (!dbe) throw 'File not found.';

			let Move = function() {
				LOG("Sending remove request for " + dbe.node + ': ' + dbe.file);
				let ctx = {
					a: 'm',
					n:  dbe.node,
					t:  M.localStorage.kRubbishID,
					i:  M.requesti
				};
				this._apiReq(ctx, function m_handler(res) {

					if (res !== 0) {
						if (res === -2 && Move) {
							Move();
							Move = null;
						} else {
							ERR('Move error: ' + res);
							aCallback.onStopRequest(null, null, Ci.nsIMsgCloudFileProvider.uploadErr);
						}
					} else {
						aCallback.onStopRequest(null, null, Cr.NS_OK);
						this._deleteDatabaseEntry('node', dbe.node);
					}
				}.bind(this));
			}.bind(this);

			if (!this._loggedIn) {
				this.requestObserver = aCallback;
				this._logonAndGetUserInfo(Move, null, true);
			} else {
				Move();
			}
		} catch(e) {
			ERR(e);
			throw Cr.NS_ERROR_FAILURE;
		}
	},

	/**
	 * This function is used by our testing framework to override the default
	 * URL's that nsMEGA connects to.
	 */
	overrideUrls : function nsMEGA_overrideUrls(aNumUrls, aUrls) {
		gServerUrl = aUrls[0];
	},

	/**
	 * logon to the mega account.
	 *
	 * @param successCallback - called if logon is successful
	 * @param failureCallback - called back on error.
	 * @param aWithUI if false, logon fails if it would have needed to put up UI.
	 *                This is used for things like displaying account settings,
	 *                where we don't want to pop up the auth ui.
	 */
	logon : function nsMEGA_logon(aSuccessCallback, aFailureCallback, aWithUI) {
		let __weakRef__ = this._authData.n;
		let window = aWithUI && Services.wm.getMostRecentWindow(null);

		let successCallback = function __logonSuccess() {
			if (window) gModalWindowList.detach(window);
			aSuccessCallback(window);
		};
		let failureCallback = function __logonFailure() {
			mozRunAsync(aFailureCallback);
			if (window) gModalWindowList.detach(window);
		};
		let promptPassword = function __logonPrompt() {
			if (aWithUI) {
				if (gModalWindowList.mStateDepth(window)) {
					LOG("Modal dialog were found open...");
					gModalWindowList.wait(window, promptPassword);
				} else {
					try {
						let p = this.askPassword(window);
						if (!p)
							throw 'No password given.';
						let pin;
						if (ctx.mfauth) {
							pin = this.askPassword(window, true);
							if (!pin) throw 'No PIN given.';
						}
						M.u_login(ctx, this._userName, p, ctx.authsalt || null, true, pin);
					} catch(e) {
						Cu.reportError(e);
						mozRunAsync(failureCallback);
					}
				}
			} else {
				mozRunAsync(failureCallback);
			}
		}.bind(this);

		if (window) {
			gModalWindowList.watch(window);
			__bug1140687(window);
		}

		let ctx = {
			_checking : !0,
			checkloginresult : function checkloginresult(ctx, r) {
				if (r != 3) LOG('checkloginresult, u_type: ' + r);
				if (r == 3) {
					M.u_type = r;
					this._loggedIn = true;
					if (kDebug) {
						try {
							LOG('Logged in as ' + JSON.parse(M.localStorage.attr).name);
						}
						catch (e) {}
					}
					if (ctx._checking !== true) {
						this._getUserInfo(function () {
							let cstrgn = this._userInfo.cstrgn;
							if (!cstrgn)
								ERR("Missing 'cstrgn'");
							else {
								cstrgn = Object.keys(cstrgn);
								if (cstrgn.length < 3)
									ERR("Invalid 'cstrgn'");
								else {
									let a = String(cstrgn[0]);
									let b = String(cstrgn[2]);
									LOG('RootID: ' + a);
									LOG('RubbishID: ' + b);
									if ((a + b).length != 16)
										ERR("Unexpected 'cstrgn'");
									else {
										M.localStorage.kRootID = a;
										M.localStorage.kRubbishID = b;
										M.createfolder('Thunderbird', function cf_handler(res) {
											if (typeof res !== 'string')
												ERR('Error creating folder: ' + res);
											else
												LOG('Thunderbird folder created with ID ' + res);
											this._authData = true;
											successCallback();
										}.bind(this));
									}
								}
							}
							if (!M.localStorage.kRootID) {
								failureCallback();
							}
						}.bind(this), failureCallback);
					} else {
						successCallback();
					}
				} else if (ctx._checking === true) {
					delete ctx._checking;
					mozRunAsync(promptPassword);
				} else {
					mozRunAsync(failureCallback);
				}
			}.bind(this)
		};
		try {
			M.u_checklogin(ctx, ctx.email = this._userName);
		} catch (e) {
			ERR(e);
			mozRunAsync(failureCallback);
		}
	},

	/**
	 * Log-out and destroy the current session.
	 *
	 * @param aCallback  function to invoke once the
	 *                   session is killed
	 */
	_killSession : function nsMEGA__killSession(aCallback) {
		this._authData = null;
		this._loggedIn = false;
		M.u_logout(aCallback);
	},

	/**
	 * Wrapper around M.api_req which takes care of
	 * killing session if found invalid and re-login.
	 */
	_apiReq : function nsMEGA__apiReq(ctx, callback) {
		let retryAttempt;
		let API_REQ = M.api_req.bind(M, ctx, {
			callback : function _apiReqHandler(res, ctx, xhr) {
				if (res === M.ESID && !retryAttempt) {
					LOG('Got ESID, retrying...');
					retryAttempt = true;
					this._killSession(function onApiReqESID() {
						LOG('Session killed, re-login...');
						this._logonAndGetUserInfo(API_REQ, callback, true);
					}.bind(this));
				} else {
					callback(res, ctx, xhr);
				}
			}.bind(this)
		});
		API_REQ();
	},

	/**
	 * Prompts the user for a password. Returns the empty string on failure.
	 */
	askPassword : function nsMEGA_askPassword(aWindow, aMFAuth) {
		LOG("Getting password for user: " + this._userName);

		let password = { value : "" };
		let messengerBundle = Services.strings
			.createBundle("chrome://messenger/locale/messenger.properties");
		let win = aWindow || Services.wm.getMostRecentWindow(null);
		let authPrompter = Services.ww.getNewAuthPrompter(win);
		let promptString = messengerBundle.formatStringFromName("passwordPrompt",
				[this._userName,
					this.displayName],
				2);

		if (aMFAuth) {
			promptString = 'Enter your 2FA code:';
		}

		let serviceURL = this.serviceURL.replace('//',
			'//' + encodeURIComponent(this._userName) + '@');
		if (authPrompter.promptPassword(this.displayName, promptString,
				serviceURL, authPrompter.SAVE_PASSWORD_NEVER, password))
			return password.value;

		return "";
	},

	/**
	 * Utility functions to inject and handle an
	 * uploads progress-meter on the Composer window.
	 */
	set _meterValue(aChunkSize) {
		let p = this._pmObj;
		if (p) {
			p.current += +aChunkSize|0;
			p.meter.value = p.current*100/p.total;
			LOG('Progress('+this._pmID+'): '+p.current+'/'+p.total+' ('+p.meter.value+'%)');
		}
	},
	get _pmObj() {
		return M._progressmeter && M._progressmeter[this._pmID];
	},
	_removeProgressMeter: function nsMEGA__removeProgressMeter(aTransfered, aTotal) {
		let p = this._pmObj;
		if (p) {
			if (+aTransfered !== +aTotal) {
				p.current -= aTransfered;
				p.total -= aTotal;
			}
			if (p.current == p.total) {
				p.toolbar.removeChild(p.hbox);
				delete M._progressmeter[this._pmID];
			}
		}
	},
	_addProgressMeter: function nsMEGA__addProgressMeter() {
		if (!M._progressmeter) {
			M._progressmeter = {};
		}
		if (!this._pmID) {
			this._pmID = (Math.random()*Date.now()).toString(27);
		}
		let mDomID = 'megafilelink-meter';
		let doc = (Services.wm.getMostRecentWindow('msgcompose') || {}).document;
		if (doc) {
			let pm = doc.getElementById(mDomID);
			if (pm) {
				let id = pm.getAttribute(mDomID);
				if (M._progressmeter[id]) {
					doc = null;
					this._pmID = id;
				} else {
					ERR("ProgressMeter Error...");
					pm.parentNode.removeChild(pm);
				}
			}
		}
		if (doc) {
			var tb = doc.getElementById('composeToolbar2');
			if (!tb || tb.collapsed) {
				tb = doc.getElementById('FormatToolbar');
			}
			if (tb) {
				let t,h = doc.createElement('hbox');
				h.setAttribute('id', mDomID);
				h.setAttribute(mDomID, this._pmID);
				// h.appendChild(doc.createElement('toolbarseparator'))
				h.appendChild(doc.createElement('toolbarbutton'))
					.setAttribute('image', this.iconClass);
				h.appendChild(doc.createElement('progressmeter')).mode = 'determined';
				if (tb.lastElementChild.localName !== 'spacer') {
					tb.appendChild(doc.createElement('spacer')).flex = 1
				}
				tb.appendChild(h);
				M._progressmeter[this._pmID] = {
					total   : 0,
					current : 0,
					hbox    : h,
					toolbar : tb,
					meter   : h.childNodes[1]
				};
			}
		}
	},

	/**
	 * SQLite Database connection
	 */
	get db() {
		if (!this._DBConn) {
			let file;
			try {
				file = Services.dirsvc.get("ProfD", Ci.nsIFile);
				file.append("megalinks.sqlite");
				let db = Services.storage.openDatabase(file);
				if (!db.tableExists('ftou')) {
					db.createTable('ftou', "time INTEGER, file STRING, link STRING, node STRING, hash STRING");
				}
				Object.defineProperty(this, "_DBConn", {value:db});
			} catch (e) {
				ERR(e);
				if (e.result != Cr.NS_ERROR_OUT_OF_MEMORY)
					try {
						if (file && file.exists()) {
							file.remove(false);
						}
					} catch (e) {
						ERR(e);
					}
			}
		}
		return this._DBConn;
	},

	/**
	 * Retrieves the cached auth secret for this account.
	 */
	get _authData() {
		let data = cloudFileAccounts.getSecretValue(this.accountKey, kAuthSecretRealm);
		// LOG('_authData.get: ' + data);
		M.localStorage = {};
		if (data)
			try {
				M.localStorage = JSON.parse(M.from8(M.base64urldecode(data)));
			} catch (e) {
				ERR(e);
			}
		return M.localStorage;
	},

	/**
	 * Sets the cached auth secret for this account.
	 *
	 * @param aStore boolean whether to save localStorage
	 */
	set _authData(aStore) {
		if (aStore) {
			aStore = M.base64urlencode(M.to8(JSON.stringify(M.localStorage)));
		} else {
			M.localStorage = {};
		}
		// LOG('_authData.set: ' + aStore);
		cloudFileAccounts.setSecretValue(this.accountKey, kAuthSecretRealm, aStore || "");
	},

	/**
	 * Retrieves the cached auth token for this account.
	 */
	get _cachedAuthToken() {
		let authToken = cloudFileAccounts.getSecretValue(this.accountKey,
				cloudFileAccounts.kTokenRealm);
		if (!authToken)
			return "";

		return authToken;
	},

	/**
	 * Sets the cached auth token for this account.
	 *
	 * @param aAuthToken the auth token to cache.
	 */
	set _cachedAuthToken(aAuthToken) {
		cloudFileAccounts.setSecretValue(this.accountKey,
			cloudFileAccounts.kTokenRealm,
			aAuthToken);
	}
};

let rID = 0;
function nsMEGAChunkUploader(aUploader, aOffset, aLength) {
	this.pid      = 'Chunk$' + aOffset + '.' + aLength + '-' + (++rID);
	this.backoff  = 400+Math.floor(Math.random()*600);
	this.uploader = aUploader;
	this.offset   = aOffset;
	this.bytes    = aLength;
	this.retries  = 0;
}
nsMEGAChunkUploader.prototype = {
	/**
	 * Start uploading a chunk of data
	 */
	start : function nsMCU_start() {
		let url = this.uploader.url + this.suffix;
		let xhr, chunk = this;

		// LOG('Starting nsMEGAChunkUploader ' + chunk.pid + ' for ' + url);

		xhr = M.getxhr();
		xhr.onerror = xhr.ontimeout = function nsMCX_OnError(ev) {
			LOG(chunk.pid + ' nsMEGAChunkUploader XHR ' + ev.type);
			chunk.uploader.lastError = ev.type;
			chunk._error();
		};
		xhr.onload = function nsMCX_OnLoad(ev) {
			LOG(chunk.pid + ' nsMEGAChunkUploader XHR Load ' + xhr.status);

			if (xhr.status == 200 && typeof xhr.response === 'string' && xhr.statusText == 'OK') {
				let response = xhr.response;
				if (response.length > 27) {
					response = M.base64urldecode(response);
				}
				LOG('nsMEGAChunkUploader ' + chunk.pid + ' finished, ' + response.length);

				let u = chunk.uploader;
				if (!response.length || response == 'OK' || response.length == 27) {

					if (response.length == 27) {
						let t = Object.keys(u.ul_macs)
							.map(Number)
							.sort((a, b) => a - b)
							.map(m => u.ul_macs[m]);
						let key = u.ul_key;
						let mac = M.condenseMacs(t, key);
						key = [
							key[0]^key[4],
							key[1]^key[5],
							key[2]^mac[0]^mac[1],
							key[3]^mac[2]^mac[3],
							key[4],
							key[5],
							mac[0]^mac[1],
							mac[2]^mac[3]
						];

						t = { n : u.saveAs || u.file.leafName, hash : u.hash };
						u._apiCompleteUpload = [response, t, key, u._complete.bind(u, key)];
						M.api_completeupload.apply(M, u._apiCompleteUpload);
					}

					delete chunk.u8data;
					delete u.activeUploads[chunk.pid];
					u.transfered += chunk.bytes;
					u.owner._meterValue = chunk.bytes;
					mozRunAsync(u._dispatch.bind(u));
				} else {
					ERR('EKEY Upload Error');
					u.owner._meterValue = -u.transfered;
					u._restart(EKEY);
				}
			} else {
				LOG('nsMEGAChunkUploader ' + chunk.pid + ' FAILED, ' + xhr.response + ' (' + xhr.status + ') ' + xhr.statusText);
				chunk._error();
			}
		};
		xhr.timeout = 180000;
		xhr.push('POST', url, this.u8data.buffer);
		this.xhr = xhr;
	},

	/**
	 * Handle an error uploading a chunk
	 */
	_error : function nsMCU__error() {
		if (this.xhr) {
			delete this.xhr;
			if (++this.retries < this.uploader.maxChunkRetries) {
				this.retryTimer = M.setTimeout(this.start.bind(this), this.backoff *= 1.7);
			} else {
				this.uploader.cancel(Ci.nsIMsgCloudFileProvider.uploadErr);
			}
		}
	}
};

function nsMEGAEncrypter() {
	let n = this.nw = 4, self = this;

	this.queue = [];
	this.worker = Array(n);

	while (n--) {
		let wrk = new Worker("chrome://mega-filelink/content/core/encrypter.js");

		wrk.onmessage = function nsMEW_OnMessage(ev) {
			let job = this.job, chunk = job.chunk, uploader = chunk.uploader;

			// LOG(chunk.pid + ' Worker Reply: ' + ev.data);

			if (typeof ev.data == 'string') {
				if (ev.data[0] == '[')
					uploader.ul_macs[chunk.offset] = JSON.parse(ev.data);
			} else {
				try {
					chunk.u8data = new Uint8Array(ev.data.buffer || ev.data);
					chunk.suffix = '/' + chunk.offset + '?c=' + M.base64urlencode(M.chksum(chunk.u8data.buffer));
					if (job.callback) {
						job.callback(chunk);
					}
					mozRunAsync(self.pop.bind(self));
					delete this.job;
					delete this.busy;
				} catch (e) {
					ERR(e);
					this.onerror(e);
				}
			}
		};

		wrk.onerror = function nsMEW_OnError(err) {
			ERR(this.job.chunk.pid + ' Worker Exception: ' + err);

			this.job.chunk.uploader.cancel(Cr.NS_ERROR_FAILURE);
		};

		this.worker[n] = wrk;
	}
}
nsMEGAEncrypter.prototype = {
	push : function nsMEPush(aChunkUploader, aData, aCallback) {
		this.queue.push({
			data : aData,
			chunk : aChunkUploader,
			callback : aCallback
		});
		aChunkUploader.ready = true;
		if (aCallback)
			this.pop();
	},
	pop : function nsMEPop() {
		let n = this.nw;
		while (n--) {
			let wrk = this.worker[n];
			if (!wrk.busy) {
				let job = this.queue.shift();
				if (!job)
					break;

				// LOG('Starting nsMEGAEncrypter $' + job.chunk.offset);

				wrk.job = job;
				wrk.busy = true;
				wrk.postMessage(job.chunk.uploader.ul_keyNonce);
				wrk.postMessage(job.chunk.offset / 16);
				wrk.postMessage(job.data.buffer);
			}
		}
	},
	exists : function nsMEExists(chunk) {
		let i = this.queue.length;
		while (i--) {
			if (this.queue[i].chunk === chunk) {
				return this.queue[i];
			}
		}
		for (i = this.nw; i--; ) {
			let wrk = this.worker[i];
			if (wrk.busy && wrk.job.chunk === chunk) {
				return wrk.job;
			}
		}
		return false;
	}
};

function nsMEGAFileUploader(aOwner, aFile, aCallback, aRequestObserver, aFilename) {
	this.file            = aFile;
	this.owner           = aOwner;
	this.saveAs          = aFilename;
	this.callback        = aCallback;
	this.requestObserver = aRequestObserver;
	this.retries         = -1;
	this.encrypter       = null;
	this.lastError       = null;
	this.transfered      = null;
	this.inputStream     = null;
	this.binaryStream    = null;
	this.activeUploads   = null;
}
nsMEGAFileUploader.prototype = {
	get maxSimUploads()     { return   4 },
	get maxChunkRetries()   { return   7 },
	get maxUploadRetries()  { return   9 },
	get maxEncrypterJobs()  { return  16 },

	/**
	 * Kicks off the upload request for the file associated with this Uploader.
	 *
	 * @param  aNoDB  Do not query the DB
	 */
	uploadFile : function nsMFU_uploadFile(aNoDB) {
		if (!aNoDB) {
		  this.requestObserver.onStartRequest(null, null);

		  let ___dbWeakRef___ = this.owner.db; // do NOT remove
		  let dbe = this.owner._getDatabaseEntry('file', this.file.path);
		  if (dbe) {
			let cached_link;
			LOG('Got DB Item with link ' + dbe.link);
			if (+dbe.time == this.file.lastModifiedTime) {
				LOG('Has matching time ' + dbe.time);
				cached_link = dbe.link;
			}

			if (cached_link) {
				let pubNode = cached_link.match(/!([\w-]{8})!/);
				if (pubNode && (pubNode = pubNode[1])) {
					LOG('Checking node validity: ' + pubNode);
					return this.owner._apiReq({"a":"g","p":pubNode},function(res) {

						if (typeof res === 'number' && res < 0) {
							LOG('The link is no longer live: ' + res);
							this.owner._deleteDatabaseEntry('file', dbe.file);
							this.uploadFile(true);
						} else {
							this.owner._setSharedURL(this.file, cached_link);
							this.callback(Cr.NS_OK);
						}
					}.bind(this));
				} else {
					// This shouldn't happen
					ERR('Invalid DB link: ' + cached_link);
					this.owner._deleteDatabaseEntry('link', cached_link);
				}
			}
		  }
		}

		LOG("nsMEGAFileUploader.uploadFile: " + this.file.leafName);
		try {
			this.inputStream = Cc["@mozilla.org/network/file-input-stream;1"]
				.createInstance(Ci.nsIFileInputStream);
			this.inputStream.QueryInterface(Ci.nsISeekableStream);
			this.inputStream.init(this.file, -1, -1, false);

			this.binaryStream = Cc["@mozilla.org/binaryinputstream;1"]
				.createInstance(Ci.nsIBinaryInputStream);
			this.binaryStream.setInputStream(this.inputStream);

			LOG('Generating fingerprint for ' + this.file.leafName);
			M.fingerprint(this, function __fingerprint_cb(hash) {
				LOG('fingerprint: ' + hash);
				try {
					if (!hash) {
						throw new Error('Failed to generate fingerprint');
					}
					this.hash = hash;
					this._init();
				} catch (e) {
					ERR(e);
					mozRunAsync(this.cancel.bind(this, Cr.NS_ERROR_FAILURE));
				}
			}.bind(this));
		} catch (e) {
			ERR(e);
			mozRunAsync(this.cancel.bind(this, Cr.NS_ERROR_FAILURE));
		}
	},

	/**
	 * Cancels the upload request for the file associated with this Uploader.
	 *
	 * @param aStatus  If an error, why are we canceling the upload
	 */
	cancel : function nsMFU_cancel(aStatus) {
		LOG('Canceling upload ' + this.file.leafName + ', Status: ' + aStatus);
		this._abort();
		this._close();
		this.callback(aStatus || Ci.nsIMsgCloudFileProvider.uploadCanceled);
		delete this.callback;
	},

	/**
	 * Close the associated input stream for this upload
	 */
	_close : function nsMFU__close() {
		if (this.binaryStream) {
			mozCloseStream(this.inputStream);
			delete this.inputStream;
			delete this.binaryStream;
		}
	},

	/**
	 * Reads a chunk of data from disk, returns a typed-array
	 *
	 * @param aOffset The offset to starter reading from
	 * @param aLength The number of bytes to read
	 */
	_read : function nsMFU__read(aOffset, aLength) {
		try {
			this.inputStream.seek(0, aOffset);
			let data = this.binaryStream.readByteArray(aLength);
			return new Uint8Array(data);
		} catch (e) {
			ERR(e);
		}
		return null;
	},

	/**
	 * Reads a chunk of data from disk, returns a string
	 *
	 * @param aOffset The offset to starter reading from
	 * @param aLength The number of bytes to read
	 */
	_read2 : function nsMFU__read2(aOffset, aLength) {
		try {
			this.inputStream.seek(0, aOffset);
			return this.binaryStream.readBytes(aLength);
		} catch (e) {
			ERR(e);
		}
		return null;
	},

	/**
	 * Abort active workers and chunk uploads
	 */
	_abort : function nsMFU__abort() {
		if (this.encrypter) {
			this.encrypter.worker.map(w => w.terminate());
			this.encrypter = null;
		}
		for(let k in this.activeUploads) {
			let chunk = this.activeUploads[k];
			LOG('Aborting ' + chunk.pid + ', ' + (typeof chunk.xhr));
			let xhr = chunk.xhr;
			if (xhr) {
				delete chunk.xhr;
				if (xhr.channel) {
					xhr.channel.cancel(Cr.NS_BINDING_ABORTED);
				} else {
					xhr.abort();
				}
			}
			M.clearTimeout(chunk.retryTimer);
		}
		delete this.chunks;
		delete this.activeUploads;
	},

	/**
	 * Dispatch a queued chunk, read -> encrypt -> upload
	 */
	_dispatch : function nsMFU__dispatch() {
		let t = this.maxSimUploads - Object.keys(this.activeUploads).length;
		// LOG('_dispatch, ' + t + ' slots');
		while (t--) {
			let chunk = this.chunks.pop(), job, callback;
			if (!chunk)
				break;

			callback = chunk.start.bind(chunk);
			if ((job = this.encrypter.exists(chunk))) {
				LOG('Got pending encrypter job, ' + chunk.pid + '; ' + (typeof job.callback));
				job.callback = callback;
			} else if (!chunk.u8data) {
				let data = this._read(chunk.offset, chunk.bytes);
				if (!data)
					return this.cancel(Cr.NS_ERROR_FAILURE);

				this.encrypter.push(chunk, data, callback);
			} else {
				mozRunAsync(callback);
			}
			this.activeUploads[chunk.pid] = chunk;
		}

		if (this.chunks.length) {
			let idx = this.chunks.length;
			while (this.encrypter.queue.length < this.maxEncrypterJobs) {
				let chunk = this.chunks[--idx];
				if (!chunk || chunk.u8data)
					break;

				if (!chunk.ready) {
					let data = this._read(chunk.offset, chunk.bytes);
					if (!data)
						break;

					this.encrypter.push(chunk, data);
				}
			}
			mozRunAsync(this.encrypter.pop.bind(this.encrypter));
		}
		LOG('activeUploads', Object.keys(this.activeUploads).length);
	},

	/**
	 * Completes an upload.
	 *
	 * @param aKey     The encryption key
	 * @param aHandle  The handle for the uploaded file
	 */
	_complete : function nsMFU__complete(aKey, aHandle, aPrivHandle) {
		if (typeof aHandle === 'string' && aHandle.length === 8) {
			let link = 'https://mega.nz/#!' + aHandle + '!' + M.a32_to_base64(aKey);
			this.owner._setSharedURL(this.file, link, aPrivHandle, this.hash);
			this.callback(Cr.NS_OK);
			M.api_req({a: 'log', e: 99799});
		} else {
			ERR('Upload error', aHandle);
			this.owner._killSession(function onUploadError() {
				if (typeof aHandle === 'number' && aHandle < 0 && !this.onUploadErrorLogon) {
					LOG('Re-login on upload error...', this._apiCompleteUpload);
					this.onUploadErrorLogon = aHandle;
					this.owner.logon(function() {
						M.api_completeupload.apply(M, this._apiCompleteUpload);
					}.bind(this), this._apiCompleteUpload[3], true);
				} else {
					this.cancel(Ci.nsIMsgCloudFileProvider.uploadErr);
				}
			}.bind(this));
		}
		this._close();
	},

	/**
	 * Restart from scratch a failed upload
	 */
	_restart : function nsMFU__restart(aStatus) {
		this.lastError = aStatus;
		try {
			this._abort();
			this._init();
		} catch (e) {
			this.cancel(Cr.NS_ERROR_FAILURE);
		}
	},

	/**
	 * Initialize the file upload procedure
	 */
	_init : function nsMFU__init() {

		if (++this.retries > this.maxUploadRetries) {
			return this.cancel(Ci.nsIMsgCloudFileProvider.uploadErr);
		}

		if (!this.encrypter)
			this.encrypter = new nsMEGAEncrypter();

		this.owner._apiReq({
			a : 'u',
			ssl : 0,
			ms : 0,
			s : this.file.fileSize,
			r : this.retries,
			e : this.lastError || ""
		}, function u_handler(res, ctx) {

				if (typeof res === 'object' && /^http/.test(String(res.p))) {
					this.url = res.p;
					this.ul_macs = [];
					if (!this.ul_key) {
						this.ul_key = Array(6);
						for (let i = 6; i--; )
							this.ul_key[i] = M.rand(0x100000000);
						this.ul_keyNonce = JSON.stringify(this.ul_key);
					}
					let offset = 0, index = 0, i;
					let chunks = [], size = this.file.fileSize;
					let chunk_size = 1048576, block_size = 131072;
					for (i = 1; i <= 8 && offset < size - i * block_size; i++) {
						chunks.push(new nsMEGAChunkUploader(this, index = offset, i * block_size));
						offset += i * block_size
					}
					while (offset < size) {
						chunks.push(new nsMEGAChunkUploader(this, index = offset, chunk_size));
						offset += chunk_size
					}
					if (size - index > 0) {
						chunks.pop();
						chunks.push(new nsMEGAChunkUploader(this, index, size - index));
					}
					LOG('File split into ' + chunks.length + ' chunks');
					this.chunks = chunks.reverse();
					this.activeUploads = {};
					this.transfered = 0;
					this._dispatch();
				} else {
					ERR('u-handshake error');
					this.cancel(Cr.NS_ERROR_FAILURE);
				}
			}.bind(this));
	}
};

const gModalWindowList = {
	wms : new WeakMap(),
	fpc : ['attachToCloud', 'AttachFile'],
	watch : function GMWL_watch(aWindow) {
		if (this.wms.has(aWindow)) {
			LOG('Found window ' + aWindow.location);
			return false;
		}
		LOG('Watching window ' + aWindow.location);

		let self = this;
		aWindow.addEventListener("DOMWillOpenModalDialog", this, false);
		aWindow.addEventListener("DOMModalDialogClosed", this, false);
		this.fpc.forEach(function(fn) {

			aWindow['__MEGA_' + fn] = aWindow[fn];
			aWindow[fn] = (function __MEGA_GMWW(fn) {
				return function() {
					let wm = self.wms.get(aWindow);
					wm.mStateDepth++;
					LOG('Calling "'+fn+'"... ' + wm.mStateDepth);
					aWindow['__MEGA_' + fn].apply(aWindow, arguments);
					self.dispatch(wm);
				};
			})(fn);
		});
		this.wms.set(aWindow, {mStateDepth : 0, wl : []});
	},
	detach: function GMWL_detach(aWindow) {
		if (this.wms.has(aWindow)) {
			LOG('Detaching from window ' + aWindow.location);
			this.fpc.forEach(function(fn) {
				aWindow[fn] = aWindow['__MEGA_' + fn];
				delete aWindow['__MEGA_' + fn];
			});
			aWindow.removeEventListener("DOMWillOpenModalDialog", this, false);
			aWindow.removeEventListener("DOMModalDialogClosed", this, false);
			this.wms.delete(aWindow);
		}
	},
	wait: function GMWL_wait(aWindow, aCallback) {
		if (this.wms.has(aWindow)) {
			let wm = this.wms.get(aWindow);
			wm.wl.push(aCallback);
			LOG("Added wait callback " + aCallback.name);
		}
	},
	dispatch: function GMWL_dispatch(aWeakMap) {
		if (--aWeakMap.mStateDepth === 0) {
			LOG("Dispatching waiters... " + aWeakMap.wl.length);
			if (aWeakMap.wl.length) {
				aWeakMap.wl.map(mozRunAsync);
				aWeakMap.wl = [];
			}
		}
	},
	handleEvent: function GMWL_handleEvent(ev) {
		let wm = this.wms.get(ev.target);
		LOG(ev.type + ': ' + (wm||{}).mStateDepth);
		if (wm) switch(ev.type) {
			case 'DOMWillOpenModalDialog':
				wm.mStateDepth++;
				break;
			case 'DOMModalDialogClosed':
				this.dispatch(wm);
				break;
		}
	},
	mStateDepth: function GMWL_mStateDepth(aWindow) {
		return this.wms.has(aWindow) && this.wms.get(aWindow).mStateDepth;
	}
};

const gWindowListener = {
	register: function() {
		Services.wm.addListener(this);

		let windows = Services.wm.getEnumerator('msgcompose');
		while(windows.hasMoreElements()) {
			let domWindow = windows.getNext().QueryInterface(Ci.nsIDOMWindow);
			this.attachTo(domWindow);
		}
	},
	unregister: function() {
		Services.wm.removeListener(this);
	},
	attachTo: function(aWindow) {
		let windowType;

		try {
			windowType = aWindow.document.documentElement.getAttribute("windowtype");
		}
		catch (ex) {}

		if (windowType === 'msgcompose') {
			monkeyPatchDOMWindow(aWindow);
		}
	},
	onOpenWindow: function (aWindow) {
		let domWindow = aWindow.QueryInterface(Ci.nsIInterfaceRequestor)
			.getInterface(Ci.nsIDOMWindowInternal || Ci.nsIDOMWindow);

		domWindow.addEventListener("load", function gWLoad() {
			domWindow.removeEventListener("load", gWLoad, false);
			gWindowListener.attachTo(domWindow);
			domWindow = undefined;
		}, false);
	},
	onCloseWindow: function (aWindow) {},
	onWindowTitleChange: function (aWindow, aTitle) {}
};

const gSTempStorage = Object.create(null);
const mozLazyGetService = XPCOMUtils.defineLazyServiceGetter.bind(XPCOMUtils, this);

mozLazyGetService("mozMIMEService", "@mozilla.org/mime;1", "nsIMIMEService");
mozLazyGetService("mozAlertsService", "@mozilla.org/alerts-service;1", "nsIAlertsService");
mozLazyGetService("mozIStorageService", "@mozilla.org/storage/service;1", "mozIStorageService");
mozLazyGetService("mozClipboardHelper", "@mozilla.org/widget/clipboardhelper;1", "nsIClipboardHelper");
mozLazyGetService("mozPromptService", "@mozilla.org/embedcomp/prompt-service;1", "nsIPromptService");
mozLazyGetService("mozRandomGenerator", "@mozilla.org/security/random-generator;1", "nsIRandomGenerator");

function alert(msg) {
	mozPromptService.alert(null, 'MEGA Filelink', msg);
}
function mozRunAsync(f) {
	Services.tm.currentThread.dispatch(f, Ci.nsIEventTarget.DISPATCH_NORMAL);
}
function mozCloseStream(s) {
	if (s instanceof Ci.nsISafeOutputStream) {
		try {
			s.finish();
			return;
		} catch (e) {
			ERR(e);
		}
	}
	s.close();
}

function __bug1140687(aWindow) {
	try {
		if (aWindow.RemoveSelectedAttachment.toSource().indexOf('cloudProvider.cancelFileUpload') === -1) {
			Services.scriptloader.loadSubScript("chrome://mega-filelink/content/bug1140687.js", aWindow);
		}
	} catch(ex) {}
}

function monkeyPatchDOMWindow(aWindow) {
	try {
		if (aWindow.uploadListener.toSource().indexOf('gSTempStorage') === -1) {
			var uploadListener = aWindow.uploadListener;
			aWindow.uploadListener = function(aAttachment, aFile) {
				if (aAttachment && typeof aAttachment.name === 'string') {
					gSTempStorage[aFile.path] = aAttachment.name;
				}
				uploadListener.apply(this, arguments);
			};
			aWindow.uploadListener.prototype = uploadListener.prototype;
		}
	} catch(ex) {}
}

const NSGetFactory = XPCOMUtils.generateNSGetFactory([nsMEGA]);
