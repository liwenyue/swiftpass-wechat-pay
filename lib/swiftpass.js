var md5 = require('md5');
var sha1 = require('sha1');
var request = require('request');
var _ = require('underscore');
var xml2js = require('xml2js');
var https = require('https');
var url_mod = require('url');

var signTypes = {
  MD5: md5,
  SHA1: sha1
};

var RETURN_CODES = {
  SUCCESS: 'SUCCESS',
  FAIL: 'FAIL'
};

var URL = "https://pay.swiftpass.cn/pay/gateway";

var URLS = {
  UNIFIED_ORDER: 'pay.weixin.native',
  JS_PAY: 'pay.weixin.jspay',
  ORDER_QUERY: 'unified.trade.query',
  REFUND: 'unified.trade.refund',
  REFUND_QUERY: 'unified.trade.refundquery',
  CLOSE_ORDER: 'unified.trade.close'
};

var Swiftpass = function(config) {
  this.subAppId = config.subAppId;
  this.partnerKey = config.partnerKey;
  this.mchId = config.mchId;
  this.notifyUrl = config.notifyUrl;
  this.passphrase = config.passphrase || config.mchId;
  this.pfx = config.pfx;
  return this;
};

Swiftpass.prototype.getBrandWCPayRequestParams = function(order, callback) {
  var self = this;
  var default_params = {
    timeStamp: this._generateTimeStamp(),
    nonceStr: this._generateNonceStr(),
    signType: 'MD5'
  };

  order = this._extendWithDefault(order, [
    'notify_url'
  ]);

  this.unifiedOrder(order, function(err, data) {
    if (err) {
      return callback(err);
    }
    callback(null, JSON.parse(data.pay_info));
  });
};

/**
 * Generate parameters for `WeixinJSBridge.invoke('editAddress', parameters)`.
 *
 * @param  {String}   data.url  Referer URL that call the API. *Note*: Must contain `code` and `state` in querystring.
 * @param  {String}   data.accessToken
 * @param  {Function} callback(err, params)
 *
 * @see https://pay.weixin.qq.com/wiki/doc/api/jsapi.php?chapter=7_9
 */
Swiftpass.prototype.getEditAddressParams = function(data, callback) {
  if (!(data.url && data.accessToken)) {
    var err = new Error('Missing url or accessToken');
    return callback(err);
  }

  var params = {
    appId: this.appId,
    scope: 'jsapi_address',
    signType: 'SHA1',
    timeStamp: this._generateTimeStamp(),
    nonceStr: this._generateNonceStr(),
  };
  var signParams = {
    appid: params.appId,
    url: data.url,
    timestamp: params.timeStamp,
    noncestr: params.nonceStr,
    accesstoken: data.accessToken,
  };
  var string = this._toQueryString(signParams);
  params.addrSign = signTypes[params.signType](string);
  callback(null, params);
};

Swiftpass.prototype._httpRequest = function(url, data, callback) {
  request({
    url: url,
    method: 'POST',
    body: data
  }, function(err, response, body) {
    if (err) {
      return callback(err);
    }

    callback(null, body);
  });
};

Swiftpass.prototype._httpsRequest = function(url, data, callback) {
  var parsed_url = url_mod.parse(url);
  var req = https.request({
    host: parsed_url.host,
    port: 443,
    path: parsed_url.path,
    pfx: this.pfx,
    passphrase: this.passphrase,
    method: 'POST'
  }, function(res) {
    var content = '';
    res.on('data', function(chunk) {
      content += chunk;
    });
    res.on('end', function() {
      callback(null, content);
    });
  });

  req.on('error', function(e) {
    callback(e);
  });
  req.write(data);
  req.end();
};

Swiftpass.prototype._signedQuery = function(url, params, options, callback) {
  var self = this;
  var required = options.required || [];
  params['service'] = url;
  params = this._extendWithDefault(params, [
    'mch_id',
    'nonce_str',
    'sub_appid'
  ]);

  params = _.extend({
    'sign': this._getSign(params)
  }, params);

  if (params.long_url) {
    params.long_url = encodeURIComponent(params.long_url);
  }

  for (var key in params) {
    if (params[key] !== undefined && params[key] !== null) {
      params[key] = params[key].toString();
    }
  }

  var missing = [];
  required.forEach(function(key) {
    var alters = key.split('|');
    for (var i = alters.length - 1; i >= 0; i--) {
      if (params[alters[i]]) {
        return;
      }
    }
    missing.push(key);
  });

  if (missing.length) {
    return callback('missing params ' + missing.join(','));
  }

  var request = (options.https ? this._httpsRequest : this._httpRequest).bind(this);
  request(URL, this.buildXml(params), function(err, body) {
    if (err) {
      return callback(err);
    }
    self.validate(body, callback);
  });

};

Swiftpass.prototype.unifiedOrder = function(params, callback) {
  var requiredData = ['body', 'out_trade_no', 'total_fee', 'mch_create_ip', 'mch_id', 'service']; //'sub_appid'
  params.notify_url = params.notify_url || this.notifyUrl;
  this._signedQuery(params['service'] || URLS.JS_PAY, params, {
    required: requiredData
  }, callback);
};

Swiftpass.prototype.orderQuery = function(params, callback) {
  this._signedQuery(URLS.ORDER_QUERY, params, {
    required: ['transaction_id|out_trade_no']
  }, callback);
};

Swiftpass.prototype.refund = function(params, callback) {
  params = this._extendWithDefault(params, [
    'op_user_id'
  ]);

  this._signedQuery(URLS.REFUND, params, {
    https: true,
    required: ['transaction_id|out_trade_no', 'out_refund_no', 'total_fee', 'refund_fee']
  }, callback);
};

Swiftpass.prototype.refundQuery = function(params, callback) {
  this._signedQuery(URLS.REFUND_QUERY, params, {
    required: ['transaction_id|out_trade_no|out_refund_no|refund_id']
  }, callback);
};

Swiftpass.prototype.closeOrder = function(params, callback) {
  this._signedQuery(URLS.CLOSE_ORDER, params, {
    required: ['out_trade_no']
  }, callback);
};

Swiftpass.prototype.parseCsv = function(text) {
  var rows = text.trim().split(/\r?\n/);

  function toArr(rows) {
    var titles = rows[0].split(',');
    var bodys = rows.splice(1);
    var data = [];

    bodys.forEach(function(row) {
      var rowData = {};
      row.split(',').forEach(function(cell, i) {
        rowData[titles[i]] = cell.split('`')[1];
      });
      data.push(rowData);
    });
    return data;
  }

  return {
    list: toArr(rows.slice(0, rows.length - 2)),
    stat: toArr(rows.slice(rows.length - 2, rows.length))[0]
  };
};

Swiftpass.prototype.buildXml = function(obj) {
  var builder = new xml2js.Builder({
    allowSurrogateChars: true
  });
  var xml = builder.buildObject({
    xml: obj
  });
  return xml;
};

Swiftpass.prototype.validate = function(xml, callback) {
  var self = this;
  xml2js.parseString(xml, {
    trim: true,
    explicitArray: false
  }, function(err, json) {
    var error = null,
      data;
    if (err) {
      error = new Error();
      err.name = 'XMLParseError';
      return callback(err, xml);
    }

    data = json ? json.xml : {};

    // if (data.return_code == RETURN_CODES.FAIL) {
    //   error = new Error(data.return_msg);
    //   error.name = 'ProtocolError';
    // } else if (data.result_code == RETURN_CODES.FAIL) {
    //   error = new Error(data.err_code);
    //   error.name = 'BusinessError';
    // }

    if (!data.pay_info) {
      error = new Error('请传入支付方式');
      error.name = 'missParamError';
    }

    callback(error, data);
  });
};

/**
 * 使用默认值扩展对象
 * @param  {Object} obj
 * @param  {Array} keysNeedExtend
 * @return {Object} extendedObject
 */
Swiftpass.prototype._extendWithDefault = function(obj, keysNeedExtend) {
  var defaults = {
    sub_appid: this.subAppId,
    mch_id: this.mchId,
    sub_mch_id: this.subMchId,
    nonce_str: this._generateNonceStr(),
    notify_url: this.notifyUrl,
    op_user_id: this.mchId,
    pfx: this.pfx
  };
  var extendObject = {};
  keysNeedExtend.forEach(function(k) {
    if (defaults[k]) {
      extendObject[k] = defaults[k];
    }
  });
  return _.extend(extendObject, obj);
};

Swiftpass.prototype._getSign = function(pkg, signType) {
  pkg = _.clone(pkg);
  delete pkg.sign;
  signType = signType || 'MD5';
  var string1 = this._toQueryString(pkg);
  var stringSignTemp = string1 + '&key=' + this.partnerKey;
  var signValue = signTypes[signType](stringSignTemp).toUpperCase();
  return signValue;
};

Swiftpass.prototype._toQueryString = function(object) {
  return Object.keys(object).filter(function(key) {
    return object[key] !== undefined && object[key] !== '';
  }).sort().map(function(key) {
    return key + '=' + object[key];
  }).join('&');
};

Swiftpass.prototype._generateTimeStamp = function() {
  return parseInt(+new Date() / 1000, 10) + '';
};

/**
 * [_generateNonceStr description]
 * @param  {[type]} length [description]
 * @return {[type]}        [description]
 */
Swiftpass.prototype._generateNonceStr = function(length) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var maxPos = chars.length;
  var noceStr = '';
  var i;
  for (i = 0; i < (length || 32); i++) {
    noceStr += chars.charAt(Math.floor(Math.random() * maxPos));
  }
  return noceStr;
};

exports.Swiftpass = Swiftpass;
