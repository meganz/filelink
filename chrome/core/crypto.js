var EINTERNAL = -1;
var EARGS = -2;
var EAGAIN = -3;
var ERATELIMIT = -4;
var EFAILED = -5;
var ETOOMANY = -6;	// too many IP addresses
var ERANGE = -7;	// file packet out of range
var EEXPIRED = -8;

// FS access errors
var ENOENT = -9;
var ECIRCULAR = -10;
var EACCESS = -11;
var EEXIST = -12;
var EINCOMPLETE = -13;

// crypto errors
var EKEY = -14;

// user errors
var ESID = -15;
var EBLOCKED = -16;
var EOVERQUOTA = -17;
var ETEMPUNAVAIL = -18;
var ETOOMANYCONNECTIONS = -19;

// custom errors
var ETOOERR = -400;

var use_ssl = 1;
var chromehack = 0;
var apipath = 'https://eu.api.mega.co.nz/';
var staticpath = 'https://eu.static.mega.co.nz/';
if (typeof requesti === 'undefined') var requesti = makeid(10);

// d=1;
// var console = {};
// console.log = function() { Cu.reportError([].slice.call(arguments).join(" ")) };
// console.error = console.log;

var getXHRInstance = function() {
	return Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance(Components.interfaces.nsIXMLHttpRequest);
};

if (!Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"]) {
	Cu.importGlobalProperties(["XMLHttpRequest"]);

	getXHRInstance = function() {
		return new XMLHttpRequest(Components.interfaces.nsIXMLHttpRequest);
	};
}

// compute final MAC from block MACs
function condenseMacs(macs,key)
{
	var i, aes, mac = [0,0,0,0];

	aes = new sjcl.cipher.aes([key[0],key[1],key[2],key[3]]);

	for (i = 0; i < macs.length; i++)
	{
		mac[0] ^= macs[i][0];
		mac[1] ^= macs[i][1];
		mac[2] ^= macs[i][2];
		mac[3] ^= macs[i][3];

		mac = aes.encrypt(mac);
	}

	return mac;
}

// convert user-supplied password array
function prepare_key(a)
{
	var i, j, r;
	var aes = [];
	var pkey = [0x93C467E3,0x7DB0C7A4,0xD1BE3F81,0x0152CB56];

	for (j = 0; j < a.length; j += 4)
	{
		key = [0,0,0,0];
		for (i = 0; i < 4; i++) if (i+j < a.length) key[i] = a[i+j];
		aes.push(new sjcl.cipher.aes(key));
	}

	for (r = 65536; r--; ) for (j = 0; j < aes.length; j++) pkey = aes[j].encrypt(pkey);

	return pkey;
}

// prepare_key with string input
function prepare_key_pw(password)
{
	return prepare_key(str_to_a32(password));
}

// unsubstitute standard base64 special characters, restore padding
function base64urldecode(data)
{
	data += '=='.substr((2-data.length*3)&3)

	data = data.replace(/\-/g,'+').replace(/_/g,'/').replace(/,/g,'');

	try {
		return atob(data);
	} catch (e) {
		return '';
	}
}

// substitute standard base64 special characters to prevent JSON escaping, remove padding
function base64urlencode(data)
{
	return btoa(data).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

// array of 32-bit words to string (big endian)
function a32_to_str(a)
{
	var b = '';

	for (var i = 0; i < a.length*4; i++)
		b = b+String.fromCharCode((a[i>>2] >>> (24-(i & 3)*8)) & 255);

	return b;
}

// array of 32-bit words ArrayBuffer (big endian)
function a32_to_ab(a)
{
	var ab = 1/*have_ab*/ ? new Uint8Array(4*a.length)
	                 : new Array(4*a.length);

	for ( var i = 0; i < a.length; i++ ) {
	    ab[4*i] = a[i]>>>24;
	    ab[4*i+1] = a[i]>>>16&255;
	    ab[4*i+2] = a[i]>>>8&255;
	    ab[4*i+3] = a[i]&255;
	}

	return ab;
}

function a32_to_base64(a)
{
	return base64urlencode(a32_to_str(a));
}

// string to array of 32-bit words (big endian)
function str_to_a32(b)
{
	var a = Array((b.length+3) >> 2);
	for (var i = 0; i < b.length; i++) a[i>>2] |= (b.charCodeAt(i) << (24-(i & 3)*8));
	return a;
}

function base64_to_a32(s)
{
	return str_to_a32(base64urldecode(s));
}

// ArrayBuffer to binary string
function ab_to_str(ab)
{
	var b = '', i;

	if (1/*have_ab*/)
	{
		var b = '';

		var ab8 = new Uint8Array(ab);

		for (i = 0; i < ab8.length; i++) b = b+String.fromCharCode(ab8[i]);
	}
	else
	{
		return ab.buffer;
	}

	return b;
}

// ArrayBuffer to binary string
function ab_to_base64(ab)
{
	return base64urlencode(ab_to_str(ab));
}

// ArrayBuffer to binary with depadding
function ab_to_str_depad(ab)
{
	var b, i;

	if (1/*have_ab*/)
	{
		b = '';

		var ab8 = new Uint8Array(ab);

		for (i = 0; i < ab8.length && ab8[i]; i++) b = b+String.fromCharCode(ab8[i]);
	}
	else
	{
		b = ab_to_str(ab);

		for (i = b.length; i-- && !b.charCodeAt(i); );

		b = b.substr(0,i+1);
	}

	return b;
}

// binary string to ArrayBuffer, 0-padded to AES block size
function str_to_ab(b)
{
	var ab, i;

	if (1/*have_ab*/)
	{
		ab = new ArrayBuffer((b.length+15)&-16);
		var ab8 = new Uint8Array(ab);

		for (i = b.length; i--; ) ab8[i] = b.charCodeAt(i);

		return ab;
	}
	else
	{
		b += Array(16-((b.length-1)&15)).join(String.fromCharCode(0));

		ab = { buffer : b };
	}

	return ab;
}

// binary string to ArrayBuffer, 0-padded to AES block size
function base64_to_ab(a)
{
	return str_to_ab(base64urldecode(a));
}

// encrypt ArrayBuffer in CTR mode, return MAC
function encrypt_ab_ctr(aes,ab,nonce,pos)
{
	var ctr = [nonce[0],nonce[1],(pos/0x1000000000) >>> 0,(pos/0x10) >>> 0];
	var mac = [ctr[0],ctr[1],ctr[0],ctr[1]];

	var enc, i, j, len, v;

	if (1/*have_ab*/)
	{
		var data0, data1, data2, data3;

		len = ab.buffer.byteLength-16;

		var v = new DataView(ab.buffer);

		for (i = 0; i < len; i += 16)
		{
			data0 = v.getUint32(i,false);
			data1 = v.getUint32(i+4,false);
			data2 = v.getUint32(i+8,false);
			data3 = v.getUint32(i+12,false);

			// compute MAC
			mac[0] ^= data0;
			mac[1] ^= data1;
			mac[2] ^= data2;
			mac[3] ^= data3;
			mac = aes.encrypt(mac);

			// encrypt using CTR
			enc = aes.encrypt(ctr);
			v.setUint32(i,data0 ^ enc[0],false);
			v.setUint32(i+4,data1 ^ enc[1],false);
			v.setUint32(i+8,data2 ^ enc[2],false);
			v.setUint32(i+12,data3 ^ enc[3],false);

			if (!(++ctr[3])) ctr[2]++;
		}

		if (i < ab.buffer.byteLength)
		{
			var fullbuf = new Uint8Array(ab.buffer);
			var tmpbuf = new ArrayBuffer(16);
			var tmparray = new Uint8Array(tmpbuf);

			tmparray.set(fullbuf.subarray(i));

			v = new DataView(tmpbuf);

			enc = aes.encrypt(ctr);

			data0 = v.getUint32(0,false);
			data1 = v.getUint32(4,false);
			data2 = v.getUint32(8,false);
			data3 = v.getUint32(12,false);

			mac[0] ^= data0;
			mac[1] ^= data1;
			mac[2] ^= data2;
			mac[3] ^= data3;
			mac = aes.encrypt(mac);

			enc = aes.encrypt(ctr);
			v.setUint32(0,data0 ^ enc[0],false);
			v.setUint32(4,data1 ^ enc[1],false);
			v.setUint32(8,data2 ^ enc[2],false);
			v.setUint32(12,data3 ^ enc[3],false);

			fullbuf.set(tmparray.subarray(0,j = fullbuf.length-i),i);
		}
	}
	else
	{
		var ab32 = _str_to_a32(ab.buffer);

		len = ab32.length-3;

		for (i = 0; i < len; i += 4)
		{
			mac[0] ^= ab32[i];
			mac[1] ^= ab32[i+1];
			mac[2] ^= ab32[i+2];
			mac[3] ^= ab32[i+3];
			mac = aes.encrypt(mac);

			enc = aes.encrypt(ctr);
			ab32[i] ^= enc[0];
			ab32[i+1] ^= enc[1];
			ab32[i+2] ^= enc[2];
			ab32[i+3] ^= enc[3];

			if (!(++ctr[3])) ctr[2]++;
		}

		if (i < ab32.length)
		{
			var v = [0,0,0,0];

			for (j = i; j < ab32.length; j++) v[j-i] = ab32[j];

			mac[0] ^= v[0];
			mac[1] ^= v[1];
			mac[2] ^= v[2];
			mac[3] ^= v[3];
			mac = aes.encrypt(mac);

			enc = aes.encrypt(ctr);
			v[0] ^= enc[0];
			v[1] ^= enc[1];
			v[2] ^= enc[2];
			v[3] ^= enc[3];

			for (j = i; j < ab32.length; j++) ab32[j] = v[j-i];
		}

		ab.buffer = _a32_to_str(ab32,ab.buffer.length);
	}

	return mac;
}

function _str_to_a32(b)
{
	var a = Array((b.length+3) >> 2);

	if (typeof b == 'string')
	{
		for (var i = 0; i < b.length; i++)
			a[i>>2] |= (b.charCodeAt(i) & 255) << (24-(i & 3)*8);
	}
	else
	{
		for (var i = 0; i < b.length; i++)
			a[i>>2] |= b[i] << ((i & 3)*8);
	}

	return a;
}

function _a32_to_str(a,len)
{
	var b = '';

	for (var i = 0; i < len; i++)
		b = b+String.fromCharCode((a[i>>2] >>> (24-(i & 3)*8)) & 255);

	return b;
}

function chksum(buf)
{
	var l, c, d;

	if (1/*have_ab*/)
	{
		var ll;

		c = new Uint32Array(3);

		ll = buf.byteLength;

		l = Math.floor(ll/12);

		ll -= l*12;

		if (l)
		{
			l *= 3;
			d = new Uint32Array(buf,0,l);

			while (l)
			{
				l -= 3;

				c[0] ^= d[l];
				c[1] ^= d[l+1];
				c[2] ^= d[l+2];
			}
		}

		c = new Uint8Array(c.buffer);

		if (ll)
		{
			d = new Uint8Array(buf,buf.byteLength-ll,ll);

			while (ll--) c[ll] ^= d[ll];
		}
	}
	else
	{
		c = Array(12);

		for (l = 12; l--; ) c[l] = 0;

		for (l = buf.length; l--; ) c[l%12] ^= buf.charCodeAt(l);

	}

	for (d = '', l = 0; l < 12; l++) d += String.fromCharCode(c[l]);

	return d;
}

// random number between 0 .. n -- based on repeated calls to rc
/*function rand(n)
{
    var r = new Uint32Array(1);
    asmCrypto.getRandomValues(r);
    return r[0] % n; // <- oops, it's uniformly distributed only when `n` divides 0x100000000
}*/

var nsIRandomGenerator = Cc["@mozilla.org/security/random-generator;1"]
	.createInstance(Ci.nsIRandomGenerator);

var rand = function fx_rand(n) {
	var r = nsIRandomGenerator.generateRandomBytes(4);
	r = (r[0] << 24) | (r[1] << 16) | (r[2] << 8) | r[3];
	if(r<0) r ^= 0x80000000;
	return r % n; // oops, it's not uniformly distributed
};

function makeid(len)
{
    var text = "";
    var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for( var i=0; i < len; i++ )
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    return text;
}

// decrypt ArrayBuffer in CTR mode, return MAC
function decrypt_ab_ctr(aes,ab,nonce,pos)
{
	var ctr = [nonce[0],nonce[1],(pos/0x1000000000) >>> 0,(pos/0x10) >>> 0];
	var mac = [ctr[0],ctr[1],ctr[0],ctr[1]];
	var enc, len, i, j, v;

	if (1/*have_ab*/)
	{
		var data0, data1, data2, data3;

		len = ab.buffer.byteLength-16;	// @@@ -15?

		var v = new DataView(ab.buffer);

		for (i = 0; i < len; i += 16)
		{
			enc = aes.encrypt(ctr);

			data0 = v.getUint32(i,false)^enc[0];
			data1 = v.getUint32(i+4,false)^enc[1];
			data2 = v.getUint32(i+8,false)^enc[2];
			data3 = v.getUint32(i+12,false)^enc[3];

			v.setUint32(i,data0,false);
			v.setUint32(i+4,data1,false);
			v.setUint32(i+8,data2,false);
			v.setUint32(i+12,data3,false);

			mac[0] ^= data0;
			mac[1] ^= data1;
			mac[2] ^= data2;
			mac[3] ^= data3;

			mac = aes.encrypt(mac);

			if (!(++ctr[3])) ctr[2]++;
		}

		if (i < ab.buffer.byteLength)
		{
			var fullbuf = new Uint8Array(ab.buffer);
			var tmpbuf = new ArrayBuffer(16);
			var tmparray = new Uint8Array(tmpbuf);

			tmparray.set(fullbuf.subarray(i));

			v = new DataView(tmpbuf);

			enc = aes.encrypt(ctr);
			data0 = v.getUint32(0,false)^enc[0];
			data1 = v.getUint32(4,false)^enc[1];
			data2 = v.getUint32(8,false)^enc[2];
			data3 = v.getUint32(12,false)^enc[3];

			v.setUint32(0,data0,false);
			v.setUint32(4,data1,false);
			v.setUint32(8,data2,false);
			v.setUint32(12,data3,false);

			fullbuf.set(tmparray.subarray(0,j = fullbuf.length-i),i);

			while (j < 16) tmparray[j++] = 0;

			mac[0] ^= v.getUint32(0,false);
			mac[1] ^= v.getUint32(4,false);
			mac[2] ^= v.getUint32(8,false);
			mac[3] ^= v.getUint32(12,false);
			mac = aes.encrypt(mac);
		}
	}
	else
	{
		var ab32 = _str_to_a32(ab.buffer);
		len = ab32.length-3;

		for (i = 0; i < len; i += 4)
		{
			enc = aes.encrypt(ctr);
			mac[0] ^= (ab32[i] ^= enc[0]);
			mac[1] ^= (ab32[i+1] ^= enc[1]);
			mac[2] ^= (ab32[i+2] ^= enc[2]);
			mac[3] ^= (ab32[i+3] ^= enc[3]);
			mac = aes.encrypt(mac);

			if (!(++ctr[3])) ctr[2]++;
		}

		if (i < ab32.length)
		{
			var v = [0,0,0,0];

			for (j = i; j < ab32.length; j++) v[j-i] = ab32[j];

			enc = aes.encrypt(ctr);
			v[0] ^= enc[0];
			v[1] ^= enc[1];
			v[2] ^= enc[2];
			v[3] ^= enc[3];

			var j = ab.buffer.length & 15;

			var m = _str_to_a32(Array(j+1).join(String.fromCharCode(255))+Array(17-j).join(String.fromCharCode(0)));

			mac[0] ^= v[0] & m[0];
			mac[1] ^= v[1] & m[1];
			mac[2] ^= v[2] & m[2];
			mac[3] ^= v[3] & m[3];
			mac = aes.encrypt(mac);

			for (j = i; j < ab32.length; j++) ab32[j] = v[j-i];
		}

		ab.buffer = _a32_to_str(ab32,ab.buffer.length);
	}

	return mac;
}

// encrypt/decrypt 4- or 8-element 32-bit integer array
function encrypt_key(cipher,a)
{
	if (!a) a = [];
	if (a.length == 4) return cipher.encrypt(a);
	var x = [];
	for (var i = 0; i < a.length; i += 4) x = x.concat(cipher.encrypt([a[i],a[i+1],a[i+2],a[i+3]]));
	return x;
}

function decrypt_key(cipher,a)
{
	if (a.length == 4) return cipher.decrypt(a);

	var x = [];
	for (var i = 0; i < a.length; i += 4) x = x.concat(cipher.decrypt([a[i],a[i+1],a[i+2],a[i+3]]));
	return x;
}

// generate attributes block using AES-CBC with MEGA canary
// attr = Object, key = [] (four-word random key will be generated) or Array(8) (lower four words will be used)
// returns [ArrayBuffer data,Array key]
function enc_attr(attr,key)
{
	var ab;

	try {
		ab = str_to_ab('MEGA'+to8(JSON.stringify(attr)));
	} catch(e) {
		msgDialog('warningb', l[135], e.message || e);
		throw e;
	}

	// if no key supplied, generate a random one
	if (!key.length) for (i = 4; i--; ) key[i] = rand(0x100000000);

	ab = asmCrypto.AES_CBC.encrypt( ab, a32_to_ab( [ key[0]^key[4], key[1]^key[5], key[2]^key[6], key[3]^key[7] ] ), false );

	return [ab,key];
}

function to8(unicode)
{
	return unescape(encodeURIComponent(unicode));
}

function from8(utf8)
{
	return decodeURIComponent(escape(utf8));
}

function getxhr()
{
	let Ci = Components.interfaces;
	let xhr = getXHRInstance();
	xhr.mozBackgroundRequest = true;
	xhr.push = function __FilelinkXHRPush(meth, url, data) {
		this.open(meth, url, true);
		if (userAgent) {
			this.setRequestHeader('User-Agent', userAgent, false);
		}
		this.channel.loadFlags |= (
			Ci.nsIRequest.LOAD_ANONYMOUS |
			Ci.nsIRequest.LOAD_BYPASS_CACHE |
			Ci.nsIRequest.INHIBIT_PERSISTENT_CACHING);
		this.send(data || null);
	};
	let userAgent = typeof _userAgent !== 'undefined' && _userAgent;
	return xhr;
}

// API command queueing
// All commands are executed in sequence, with no overlap
// @@@ user warning after backoff > 1000

// FIXME: proper OOP!
var apixs = [];

api_reset();

function api_reset()
{
	api_init(0,'cs');	// main API interface
	api_init(1,'cs');	// exported folder access
	api_init(2,'sc');	// SC queries
	api_init(3,'sc');	// notification queries
}

function api_setsid(sid)
{
	if (sid !== false) sid = 'sid=' + sid;
	else sid = '';

	apixs[0].sid = sid;
	apixs[2].sid = sid;
	apixs[3].sid = sid;
}

function api_setfolder(h)
{
	h = 'n=' + h;

	if (u_sid) h += '&sid=' + u_sid;

	apixs[1].sid = h;
	apixs[1].failhandler = folderreqerr;
	apixs[2].sid = h;
}

function stopapi()
{
    for (var i = 4; i--; )
    {
        api_cancel(apixs[i]);
        apixs[i].cmds = [[],[]];
        apixs[i].ctxs = [[],[]];
        apixs[i].cancelled = false;
    }
}

function api_cancel(q)
{
	if (q)
	{
		q.cancelled = true;
		if (q.xhr) q.xhr.abort();
		if (q.timer) clearTimeout(q.timer);
	}
}

function api_init(c,service)
{
	if (apixs[c]) api_cancel(apixs[c]);

	apixs[c] = { c : c,				// channel
				cmds : [[],[]],		// queued/executing commands (double-buffered)
				ctxs : [[],[]],		// associated command contexts
				i : 0,				// currently executing buffer
				seqno : -Math.floor(Math.random()*0x100000000),	// unique request start ID
				xhr : false,		// channel XMLHttpRequest
				timer : false,		// timer for exponential backoff
				failhandler : api_reqfailed,	// request-level error handler
				backoff : 0,
				service : service,	// base URI component
				sid : '',			// sid URI component (optional)
				rawreq : false,
				setimmediate : false };
}

function api_req(req,ctx,c)
{
	if (typeof c == 'undefined') c = 0;
	if (typeof ctx == 'undefined') ctx = { };

	var q = apixs[c];

	q.cmds[q.i^1].push(req);
	q.ctxs[q.i^1].push(ctx);

	if (!q.setimmediate) q.setimmediate = setTimeout(api_proc,0,q);
}

// send pending API request on channel q
function api_proc(q)
{
	if (q.setimmediate)
	{
		clearTimeout(q.setimmediate);
		q.setimmediate = false;
	}

	if (q.ctxs[q.i].length || !q.ctxs[q.i^1].length) return;

	q.i ^= 1;

	if (!q.xhr) q.xhr = getxhr();

	q.xhr.q = q;

	q.xhr.onerror = function()
	{
		if (!this.q.cancelled)
		{
			if (d) console.log("API request error - retrying");
			api_reqerror(q,-3);
		}
	}

	q.xhr.onload = function()
	{
		if (!this.q.cancelled)
		{
			var t;

			if (this.status == 200)
			{
				var response = this.responseText || this.response;

				if (d) console.log('API response: ', response);

				try {
					t = JSON.parse(response);
					if (response[0] == '{') t = [t];
				} catch (e) {
					// bogus response, try again
					console.log("Bad JSON data in response: " + response);
					t = EAGAIN;
				}
			}
			else
			{
				if (d) console.log('API server connection failed (error ' + this.status + ')');
				t = ERATELIMIT;
			}

			if (typeof t === 'object' || (t != EAGAIN && t != ERATELIMIT))
			{
				for (var i = 0; i < this.q.ctxs[this.q.i].length; i++) {
					var ctx = this.q.ctxs[this.q.i][i];
					if (typeof ctx.callback === 'function') try {
						ctx.callback(typeof t === 'object' ? t[i] : t,ctx,this);
					} catch(e) {
						console.error(e);
					}
				}

				this.q.rawreq = false;
				this.q.backoff = 0;			// request succeeded - reset backoff timer
				this.q.cmds[this.q.i] = [];
				this.q.ctxs[this.q.i] = [];

				api_proc(q);
			}
			else api_reqerror(this.q,t);
		}
	}

	if (q.rawreq === false)
	{
		q.url = apipath + q.service + '?id=' + (q.seqno++) + '&' + q.sid;

		if (typeof q.cmds[q.i][0] == 'string')
		{
			q.url += '&' + q.cmds[q.i][0];
			q.rawreq = '';
		}
		else q.rawreq = JSON.stringify(q.cmds[q.i]);
	}

	api_send(q);
}

function api_send(q)
{
	q.timer = false;

	if (d) console.log("Sending API request: " + q.rawreq + " to " + q.url);

	q.xhr.push('POST',q.url,q.rawreq);
}

function api_reqerror(q,e)
{
	if (e == EAGAIN || e == ERATELIMIT)
	{
		// request failed - retry with exponential backoff
		if (q.backoff) q.backoff *= 2;
		else q.backoff = 125;

		q.timer = setTimeout(api_send,q.backoff,q);
	}
	else q.failhandler(q.c,e);
}

function api_retry()
{
	for (var i = 4; i--; )
	{
		if (apixs[i].timer)
		{
			clearTimeout(apixs[i].timer);
			api_send(apixs[i]);
		}
	}
}

function api_reqfailed(c,e)
{
	if (d) console.log('API Request Error ' + e);

	if (e == ESID)
	{
		// u_logout(true);
		// document.location.hash = 'login';
	}
	// else if (c == 2 && e == ETOOMANY)
	// {
		// if (mDB) mDBreload();
		// else loadfm();
	// }
}

// We query the sid using the supplied user handle (or entered email address, if already attached)
// and check the supplied password key.
// Returns [decrypted master key,verified session ID(,RSA private key)] or false if API error or
// supplied information incorrect
function api_getsid(ctx,user,passwordkey,hash, pin)
{
	ctx.callback = api_getsid2;
	ctx.passwordkey = passwordkey;

	api_req({ a : 'us', user : user, uh : hash, mfa : pin },ctx);
}

function api_getsid2(res,ctx)
{
	var t, k;
	var r = false;

	if (typeof res == 'object')
	{
		var aes = new sjcl.cipher.aes(ctx.authkey || ctx.passwordkey);

		// decrypt master key
		if (typeof res.k == 'string')
		{
			k = base64_to_a32(res.k);

			if (k.length == 4)
			{
				k = decrypt_key(aes,k);

				aes = new sjcl.cipher.aes(k);

				if (typeof res.tsid == 'string')
				{
					t = base64urldecode(res.tsid);
					if (a32_to_str(encrypt_key(aes,str_to_a32(t.substr(0,16)))) == t.substr(-16)) r = [k,res.tsid];
				}
				else if (typeof res.csid == 'string')
				{
					var t = base64urldecode(res.csid);

					var privk = crypto_decodeprivkey( a32_to_str(decrypt_key(aes,base64_to_a32(res.privk))) );

					if (privk)
					{
						// TODO: check remaining padding for added early wrong password detection likelihood
						r = [k,base64urlencode(crypto_rsadecrypt(t,privk).substr(0,43)),privk];
					}
				}
			}
		}
	}

	ctx.result(ctx,r);
}

// We call ug using the sid from setsid() and the user's master password to obtain the master key (and other credentials)
// Returns user credentials (.k being the decrypted master key) or false in case of an error.
function api_getuser(ctx)
{
	api_req({ a : 'ug' },ctx);
}

function stringhash(s,aes)
{
	var s32 = str_to_a32(s);
	var h32 = [0,0,0,0];

	for (i = 0; i < s32.length; i++) h32[i&3] ^= s32[i];

	for (i = 16384; i--; ) h32 = aes.encrypt(h32);

	return a32_to_base64([h32[0],h32[2]]);
}

// Update user
// Can also be used to set keys and to confirm accounts (.c)
function api_updateuser(ctx,newuser)
{
	newuser.a = 'up';

	res = api_req(newuser,ctx);
}

function crypto_handleauth(h)
{
	return a32_to_base64(encrypt_key(u_k_aes,str_to_a32(h+h)));
}

function crypto_encodepubkey(pubkey)
{
    var mlen = pubkey[0].length * 8,
        elen = pubkey[1].length * 8;

    return String.fromCharCode(mlen/256)+String.fromCharCode(mlen%256) + pubkey[0]
         + String.fromCharCode(elen/256)+String.fromCharCode(elen%256) + pubkey[1];
}

function crypto_decodepubkey(pubk)
{
	var pubkey = [];

	var keylen = pubk.charCodeAt(0)*256+pubk.charCodeAt(1);

	// decompose public key
	for (var i = 0; i < 2; i++)
	{
		if (pubk.length < 2) break;

		var l = (pubk.charCodeAt(0)*256+pubk.charCodeAt(1)+7)>>3;
		if (l > pubk.length-2) break;

		pubkey[i] = pubk.substr(2,l);
		pubk = pubk.substr(l+2);
	}

	// check format
	if (i !== 2 || pubk.length >= 16) return false;

	pubkey[2] = keylen;

	return pubkey;
}

function crypto_encodeprivkey(privk)
{
    var plen = privk[3].length * 8,
        qlen = privk[4].length * 8,
        dlen = privk[2].length * 8,
        ulen = privk[7].length * 8;

    var t = String.fromCharCode(qlen/256)+String.fromCharCode(qlen%256) + privk[4]
          + String.fromCharCode(plen/256)+String.fromCharCode(plen%256) + privk[3]
          + String.fromCharCode(dlen/256)+String.fromCharCode(dlen%256) + privk[2]
          + String.fromCharCode(ulen/256)+String.fromCharCode(ulen%256) + privk[7];

	while ( t.length & 15 ) t += String.fromCharCode(rand(256));

    return t;
}

function crypto_decodeprivkey(privk)
{
    var privkey = [];

    // decompose private key
    for (var i = 0; i < 4; i++)
    {
		if (privk.length < 2) break;

		var l = (privk.charCodeAt(0)*256+privk.charCodeAt(1)+7)>>3;
		if (l > privk.length-2) break;

	    privkey[i] = new asmCrypto.BigNumber( privk.substr(2,l) );
	    privk = privk.substr(l+2);
    }

    // check format
    if (i !== 4 || privk.length >= 16) return false;

    // TODO: check remaining padding for added early wrong password detection likelihood

    // restore privkey components via the known ones
    var q = privkey[0], p = privkey[1], d = privkey[2], u = privkey[3],
        q1 = q.subtract(1), p1 = p.subtract(1),
        m = new asmCrypto.Modulus( p.multiply(q) ),
        e = new asmCrypto.Modulus( p1.multiply(q1) ).inverse(d),
        dp = d.divide(p1).remainder,
        dq = d.divide(q1).remainder;

    privkey = [ m, e, d, p, q, dp, dq, u ];
    for (i = 0; i < privkey.length; i++) {
        privkey[i] = asmCrypto.bytes_to_string( privkey[i].toBytes() );
    }

    return privkey;
}

// Complete upload
// We construct a special node put command that uses the upload token
// as the source handle
function api_completeupload(t,p,k,callback)
{
	// if (p.repair) uq.target = M.RubbishID;

	let a = { n : p.n };
	if (p.hash) {
		a.c = p.hash;
	}
	let ea = enc_attr(a,k);
	if (d) console.log('api_completeupload', k, ea);

	api_req({ a : 'p',
		t : localStorage.kThunderbirdID || localStorage.kRootID,
		n : [{ h : base64urlencode(t), t : 0, a : ab_to_base64(ea[0]), k : a32_to_base64(encrypt_key(u_k_aes,k))}],
		i : requesti
	},{
		callback: function(res) {
			if (d) console.log('api_completeupload', res);
			let h = typeof res == 'object' && res.f && res.f[0] && res.f[0].h;
			if (h && h.length == 8) {
				api_req({a:'l',n:h},{
					callback : function(res) {
						callback(typeof res !== 'number' && res, h);
					}
				});
			} else {
				callback(res);
			}
		}
	});
}

function createfolder(name,callback,toid)
{
	toid = toid || localStorage.kRootID;
	api_req({a: 'f', c : 1}, {
		callback: function (r) {
			var f = typeof r === 'object' && r.f, h;
			if (Array.isArray(f)) {
				for(var i in f) {
					var n = f[i];
					if(n.p == toid && n.t == 1 && n.k && !n.c) try {
						crypto_processkey(u_handle,u_k_aes,n);
						if (n.name == name) {
							h = n.h;
							break;
						}
					} catch(e) {
						if (d) console.log('cferror', e);
					}
				}
			}
			if (h) cfDone(h);
			else {
				var mkat = enc_attr({ n : name },[]);
				var attr = ab_to_base64(mkat[0]);
				var key = a32_to_base64(encrypt_key(u_k_aes,mkat[1]));
				api_req({ a: 'p',t: toid, n: [{ h:'xxxxxxxx', t:1, a:attr, k:key }],i: requesti},{
					callback: function(res,ctx) {
						var h = res && res.f && res.f[0] && res.f[0].h;
						cfDone(h, res);
					}
				});
			}
		}
	});
	function cfDone(h, res) {
		if (d) console.log(h, res, name, toid);
		if (h) localStorage['k' + name + 'ID'] = h;
		callback(h || res);
	}
}

// decrypts ciphertext string representing an MPI-formatted big number with the supplied privkey
// returns cleartext string
function crypto_rsadecrypt(ciphertext,privkey)
{
    var l = (ciphertext.charCodeAt(0)*256+ciphertext.charCodeAt(1)+7)>>3;
    ciphertext = ciphertext.substr(2,l);

    var cleartext = asmCrypto.bytes_to_string( asmCrypto.RSA_RAW.decrypt(ciphertext,privkey) );
    if (cleartext.length < privkey[0].length) cleartext = Array(privkey[0].length - cleartext.length + 1).join(String.fromCharCode(0)) + cleartext;
    if ( cleartext.charCodeAt(1) != 0 ) cleartext = String.fromCharCode(0) + cleartext; // Old bogus padding workaround

    return cleartext.substr(2);
}

var u_sharekeys = {};
var u_nodekeys = {};
var keycache = {};
var rsa2aes = {};

// Try to decrypt ufs node.
// Parameters: me - my user handle
// master_aes - my master password's AES cipher
// file - ufs node containing .k and .a
// Output: .key and .name set if successful
// **NB** Any changes made to this function
//        must be populated to keydec.js
function crypto_processkey(me,master_aes,file)
{
	var id, key, k, n;

	if (!file.k)
	{
		if (!keycache[file.h])
		{
			if (d) console.log("No keycache entry!");
			return;
		}

		file.k = keycache[file.h];
	}

	id = me;

	// do I own the file? (user key is guaranteed to be first in .k)
	var p = file.k.indexOf(id + ':');

	if (p)
	{
		// I don't - do I have a suitable sharekey?
		for (id in u_sharekeys)
		{
			p = file.k.indexOf(id + ':');

			if (p >= 0 && (!p || file.k.charAt(p-1) == '/'))
			{
				file.fk = 1;
				break;
			}

			p = -1;
		}
	}

	if (p >= 0)
	{
		delete keycache[file.h];

		var pp = file.k.indexOf('/',p);

		if (pp < 0) pp = file.k.length;

		p += id.length+1;

		key = file.k.substr(p,pp-p);

		// we have found a suitable key: decrypt!
		if (key.length < 46)
		{
			// short keys: AES
			k = base64_to_a32(key);

			// check for permitted key lengths (4 == folder, 8 == file)
			if (k.length == 4 || k.length == 8)
			{
				// TODO: cache sharekeys in aes
				k = decrypt_key(id == me ? master_aes : new sjcl.cipher.aes(u_sharekeys[id]),k);
			}
			else
			{
				if (d) console.log("Received invalid key length (" + k.length + "): " + file.h);
				return;
			}
		}
		else
		{
			// long keys: RSA
			if (u_privk)
			{
				var t = base64urldecode(key);
				try
				{
					if (t) k = str_to_a32(crypto_rsadecrypt(t,u_privk).substr(0,file.t ? 16 : 32));
					else
					{
						if (d) console.log("Corrupt key for node " + file.h);
						return;
					}
				}
				catch(e)
				{
					return;
				}
			}
			else
			{
				if (d) console.log("Received RSA key, but have no public key published: " + file.h);
				return;
			}
		}

		var ab = base64_to_ab(file.a);
		var o = dec_attr(ab,k);

		if (typeof o == 'object')
		{
			if (typeof o.n == 'string')
			{
				if (file.h)
				{
					u_nodekeys[file.h] = k;
					if (key.length >= 46) rsa2aes[file.h] = a32_to_str(encrypt_key(u_k_aes,k));
				}
				if (typeof o.c == 'string') file.hash = o.c;

				if (file.hash)
				{
					var h = base64urldecode(file.hash);
					var t = 0;
					for (var i = h.charCodeAt(16); i--; ) t = t*256+h.charCodeAt(17+i);
					file.mtime=t;
				}

				if (typeof o.t != 'undefined') file.mtime = o.t;

				file.key = k;
				file.ar = o;
				file.name = file.ar.n;
				if (file.ar.fav) file.fav=1;
			}
		}
	}
	else
	{
		if (d) console.log("Received no suitable key: " + file.h);

		if (!missingkeys[file.h])
		{
			newmissingkeys = true;
			missingkeys[file.h] = true;
		}
		keycache[file.h] = file.k;
	}
}

var missingkeys = {};
var newmissingkeys = false;

// decrypt attributes block using AES-CBC, check for MEGA canary
// attr = ab, key as with enc_attr
// returns [Object] or false
function dec_attr(attr,key)
{
	var aes;
	var b;

	attr = asmCrypto.AES_CBC.decrypt( attr, a32_to_ab( [ key[0]^key[4], key[1]^key[5], key[2]^key[6], key[3]^key[7] ] ), false );

	b = ab_to_str_depad(attr);

	if (b.substr(0,6) != 'MEGA{"') return false;

	// @@@ protect against syntax errors
	try {
		return JSON.parse(from8(b.substr(4)));
	} catch (e) {
		if (d) console.error(b, e);
		var m = b.match(/"n"\s*:\s*"((?:\\"|.)*?)(\.\w{2,4})?"/), s = m && m[1], l = s && s.length || 0, j=',';
		while (l--)
		{
			s = s.substr(0,l||1);
			try {
				from8(s+j);
				break;
			} catch(e) {}
		}
		if (~l) try {
			var new_name = s+j+'trunc'+Math.random().toString(16).slice(-4)+(m[2]||'');
			return JSON.parse(from8(b.substr(4).replace(m[0],'"n":"'+new_name+'"')));
		} catch(e) {}
		return { n : 'MALFORMED_ATTRIBUTES' };
	}
}

(function __FileFingerprint(scope) {

	var CRC_SIZE   = 16;
	var BLOCK_SIZE = CRC_SIZE*4;
	var MAX_TSINT  = Math.pow(2,32) - 1;

	function i2s(i)
	{
		return String.fromCharCode.call(String,
			i >> 24 & 0xff,
			i >> 16 & 0xff,
			i >>  8 & 0xff,
			i       & 0xff);
	}

	function serialize(v)
	{
		var p = 0, b = [];
		v = Math.min(MAX_TSINT,parseInt(v));
		while (v > 0)
		{
			b[++p] = String.fromCharCode(v & 0xff);
			v >>>= 8;
		}
		b[0] = String.fromCharCode(p);
		return b.join("");
	}

	function makeCRCTable()
	{
		var c,crcTable = [];

		for (var n = 0 ; n < 256 ; ++n )
		{
			c = n;

			for (var k = 0 ; k < 8 ; ++k )
			{
				c = ((c&1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
			}

			crcTable[n] = c;
		}

		return crcTable;
	}

	function crc32(str,crc,len)
	{
		crc = crc ^ (-1);

		for (var i = 0 ; i < len ; ++i )
		{
			crc = (crc >>> 8) ^ crc32table[(crc ^ str.charCodeAt(i)) & 0xFF];
		}

		return (crc ^ (-1)) >>> 0;
	}

	scope.fingerprint = function(aUploader,aCallback)
	{
		let aFile = aUploader.file, size = aFile.fileSize;

		crc32table = scope.crc32table || (scope.crc32table = makeCRCTable());
		if (crc32table[1] != 0x77073096) return aCallback(null);

		function Finish(crc)
		{
			aCallback(base64urlencode(crc+serialize((aFile.lastModifiedTime||0)/1000)));
		}

		if (size <= 8192)
		{
			var data = aUploader._read2(0,size), crc;
			if (!data) return aCallback(null);

			if(size <= CRC_SIZE)
			{
				crc = data;
				var i = CRC_SIZE - crc.length;
				while(i--)
					crc += "\x00";
			}
			else
			{
				var tmp = [];
				for (var i = 0; i < 4; i++)
				{
					var begin = parseInt(i*size/4);
					var len = parseInt(((i+1)*size/4) - begin);
					tmp.push(i2s(crc32(data.substr(begin,len),0,len)));
				}
				crc = tmp.join("");
			}

			Finish(crc);
		}
		else
		{
			var tmp = [], i = 0, m = 4;
			var blocks = parseInt(8192/(BLOCK_SIZE*4));

			var step = function()
			{
				if(m == i)
				{
					return Finish(tmp.join(""));
				}

				var crc = 0, j = 0;
				var next = function()
				{
					if(blocks == j)
					{
						tmp.push(i2s(crc));
						return step(++i);;
					}

					var offset = parseInt((size-BLOCK_SIZE)*(i*blocks+j)/(4*blocks-1));
					var block = aUploader._read2(offset,BLOCK_SIZE);
					if (!block) return aCallback(null);

					crc = crc32(block,crc,BLOCK_SIZE);

					j++;
					setTimeout(next, 50);
				};
				next();
			};
			step();
		}
	};
})(this);
