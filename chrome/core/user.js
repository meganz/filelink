


// global variables holding the user's identity
var u_handle;	// user handle
var u_k;		// master key
var u_k_aes;	// master key AES engine
var u_p;		// prepared password
var u_attr;		// attributes
var u_privk;	// private key

// log in
// returns user type if successful, false if not
// valid user types are: 0 - anonymous, 1 - email set, 2 - confirmed, but no RSA, 3 - complete
function u_login(ctx, email, password, uh, permanent, pin)
{
	var key_pw = prepare_key_pw(password);

	if (uh === null) {
		var pw_aes = new sjcl.cipher.aes(key_pw);
		uh = stringhash(email.toLowerCase(),pw_aes);
		permanent = true;
	}
	else {
		var salt = new Uint8Array(base64_to_ab(uh));
		var pwd = Uint8Array.from(to8(password), ch => ch.charCodeAt(0));
		var key = asmCrypto.PBKDF2_HMAC_SHA512.bytes(pwd, salt, 1e5, 32);
		ctx.authkey = base64_to_a32(ab_to_base64(key.subarray(0, 16)));
		uh = ab_to_base64(key.subarray(16, 32));
	}

	ctx.result = u_login2;
	ctx.permanent = !!permanent;

    api_getsid(ctx, email, key_pw, uh, pin);
}

function u_login2(ctx,ks)
{
	if (ks !== false)
	{
		localStorage.wasloggedin = true;
		u_logout();
		localStorage.k = JSON.stringify(ks[0]);
		localStorage.sid = ks[1];
		if (ks[2]) localStorage.privk = base64urlencode(crypto_encodeprivkey(ks[2]));
		u_checklogin(ctx,false);
	}
	else ctx.checkloginresult(ctx,false);
}

// if no valid session present, return false if force == false, otherwise create anonymous account and return 0 if successful or false if error;
// if valid session present, return user type
function u_checklogin(ctx, user)
{
	if ((u_sid = localStorage.sid))
	{
		api_setsid(u_sid);
		u_checklogin3(ctx);
	}
	else {
        var step = 0;
        var done = function () {
            if (++step === 2) ctx.checkloginresult(ctx, false);
        };
        api_req({a: 'mfag', e: user}, {
            callback: function (res) {
                ctx.mfauth = parseInt(res) === 1;
                done();
            }
        });
        api_req({a: 'us0', user: user}, {
            callback: function (res) {
                ctx.authsalt = parseInt(res.v) === 2 && res.s;
                done();
            }
        });
	}
}

function u_checklogin2(ctx,u)
{
	if (u === false) ctx.checkloginresult(ctx,false);
	else
	{
		ctx.result = u_checklogin2a;
		api_getsid(ctx,u,ctx.passwordkey);
	}
}

function u_checklogin2a(ctx,ks)
{
	if (ks === false) ctx.checkloginresult(ctx,false);
	else
	{
		u_k = ks[0];
		u_sid = ks[1];
		api_setsid(u_sid);
		localStorage.k = JSON.stringify(u_k);
		localStorage.sid = u_sid;
		u_checklogin3(ctx);
	}
}

function u_checklogin3(ctx)
{
	ctx.callback = u_checklogin3a;
	api_getuser(ctx);
}

function u_checklogin3a(res,ctx)
{
	var r = false;

	if (typeof res !== 'object')
	{
		u_logout(function u_cl3a() {
			// ctx.checkloginresult(ctx,res);
			u_checklogin(ctx, u_attr && u_attr.email || ctx.email);
		});
	}
	else
	{
		u_attr = res;
		var exclude = ['c','email','k','name','p','privk','pubk','s','ts','u','currk'];

		for (var n in u_attr)
		{
			if (exclude.indexOf(n) == -1)
			{
				try {
					u_attr[n] = from8(base64urldecode(u_attr[n]));
				} catch(e) {
					u_attr[n] = base64urldecode(u_attr[n]);
				}
			}
		}

		localStorage.attr = JSON.stringify(u_attr);
		localStorage.handle = u_handle = u_attr.u;

		try {
			u_k = JSON.parse(localStorage.k);
			if (u_attr.privk) u_privk = crypto_decodeprivkey(base64urldecode(localStorage.privk));
		} catch(e) {
		}

		u_k_aes = new sjcl.cipher.aes(u_k);
		if (!u_attr.email) r = 0;
		else if (!u_attr.c) r = 1;
		else if (!u_attr.privk) r = 2;
		else r = 3;

		// if (r == 3) u_ed25519();
		ctx.checkloginresult(ctx,r);
	}
}

// erase all local user/session information
function u_logout(logout)
{
	if (d) console.log('u_logout ' + (logout && logout.name));

	Object.keys(localStorage).forEach(function(k) {
		if (typeof localStorage[k] !== 'function') {
			delete localStorage[k];
		}
	});

	if (logout)
	{
		api_req({ 'a': 'sml' }, {
			callback: function() {
				fminitialized = false;
				notifications = u_sid = u_handle = u_k = u_attr = u_privk = u_k_aes = undefined;
				api_setsid(false);
				u_sharekeys = {};
				u_nodekeys = {};
				u_type = false;
				loggedout = true;
				api_reset();
				logout();
			}
		});
	}
}

// true if user was ever logged in with a non-anonymous account
function u_wasloggedin()
{
	return localStorage.wasloggedin;
}
