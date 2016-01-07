/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

let fmtSize;
function onLoadProvider(provider) {
	let Ci = Components.interfaces;
	let messenger = Components.classes["@mozilla.org/messenger;1"]
		.createInstance(Ci.nsIMessenger);
	fmtSize = function(s) {
		let f = messenger.formatFileSize(s);
		return f.replace(/[,.]0 /,' ');
	};
	let $ = function(id) {
		return document.getElementById(id);
	};
	let bag = provider.QueryInterface(Ci.nsIWritablePropertyBag);
	let totalSpace = provider.fileSpaceUsed + provider.remainingFileSpace;
	// let c = {"aa":[340482299370,4555,110],"bb":[102717590614,49,2],"cc":[11567309000,28,3],"dd":[32717590528,34,1],"ee":[18899,4,3]};
	let c = bag.getProperty('cstrgn') || {};
	let k = Object.keys(c), iSharesBytes = 0;
	for (let i = 3 ; i < k.length ; ++i ) {
		iSharesBytes += c[k[i]][0];
	}
	let types = {
		'#2BA6DE':[c[k[0]][0],   "Cloud Drive:"],
		'#13E03C':[c[k[2]][0],   "Rubbish Bin:"],
		'#FFD300':[iSharesBytes, "Incoming Shares:"],
		'#F07800':[c[k[1]][0],   "Inbox:"],
		'#666666':[provider.fileSpaceUsed],
		'#f0f0f0':[Math.max(0,provider.remainingFileSpace)]
	};

	let ul = $('provider-space-ul'), canvas = $('provider-space-canvas');

	c = [];
	k = Object.keys(types);
	for (let i = 0 ; i < k.length ; ++i) {
		let li = ul.children.item(i);
		if (types[k[i]][1]) {
			c.push(types[k[i]][0]);
			li.children[1].textContent = types[k[i]][1];
		}
		li.children[0].style.background = k[i];
		li.children[2].textContent = fmtSize(types[k[i]][0]);
	}

	// let l = 100 * provider.fileSpaceUsed / totalSpace;
	let usedSpace = c.reduce(function(a,b){return a+b});
	let l = 100 * usedSpace / totalSpace;
	if (l > 90) {
		$('upgrade').style.display = 'block';
	}
	if (l > 99) {
		c = [totalSpace];
		k = ['#D90007'];
	} else {
		// c.push(provider.remainingFileSpace);
		c.push(totalSpace-usedSpace);
		k.splice(4,1);
	}
	Knob(canvas, totalSpace, c, k);
	fmtSize = undefined;

	$('provider-account-settings')
		.lastElementChild.textContent = bag.getProperty('account');
}

function Knob(aCanvas, aSize, aValues, aStyles, aOptions) {
	var width = aCanvas.width, height = aCanvas.height;
	var q = Math.PI / 2, sq = 2 * Math.PI / aSize;
	var cw = width / 2, ch = height / 2, pos = 0;
	var ctx = aCanvas.getContext('2d');
	var opt = aOptions || {};

	if (typeof aValues === 'number') {
		aValues = [aValues];
		aStyles = [aStyles];
	}

	var radius = opt.radius || (cw / 1.5);
	var lineWidth = opt.lineWidth || (cw / 4);
	var outerLineWidth = opt.outerWidth || 2.0;

	if (outerLineWidth > -1) {
		ctx.beginPath();
		ctx.lineWidth = outerLineWidth;
		ctx.strokeStyle = opt.outerStroke || '#cecece';
		ctx.arc(cw, ch, radius + (lineWidth / 2 + 1) + (outerLineWidth * 2), 0, Math.PI * 2, !0);
		ctx.stroke();
	}
	ctx.lineWidth = lineWidth;
	ctx.beginPath();
	ctx.fillStyle = '#ffffff';
	ctx.arc(cw, ch, radius + (lineWidth / 2) - 1, 0, Math.PI * 2, !0);
	ctx.fill();

	for (var i = 0, m = aValues.length; i < m; ++i) {
		ctx.beginPath();
		ctx.strokeStyle = aStyles[i];
		ctx.arc(cw, ch, radius, i ? pos : -q, pos += (sq * aValues[i]) - (i ? 0 : q), false);
		ctx.stroke();
		ctx.closePath();
	}

	var size = fmtSize(aSize).split(" ");
	ctx.beginPath();
	ctx.fillStyle = opt.textColor || "#333333";
	ctx.font = "26px Verdana";
	var x1 = ctx.measureText(size[0]).width;
	var y1 = ctx.measureText("|").width;
	var y2 = Math.ceil(ch + (y1 / 2) - 4);
	ctx.fillText(size[0], cw - (x1 / 2), y2);
	ctx.fillStyle = opt.textColor || "#666666";
	ctx.font = "bold 14px Verdana";
	var x2 = ctx.measureText(size[1]).width;
	ctx.fillText(size[1], cw - (x2 / 2), y2 + y1 + 8);
}
