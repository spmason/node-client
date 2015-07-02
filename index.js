var requestify = require('requestify');
var sha1 = require('node-sha1');
var util = require('util');
var VERSION = "1.0.2";

var noop = function(){};

global.setImmediate = global.setImmediate || process.nextTick.bind(process);

var new_client = function(api_key, config) {
  var client = {};

  config = config || {};

  client.base_uri = (config.base_uri || 'https://app.launchdarkly.com').replace(/\/+$/, "");
  client.connect_timeout = config.connect_timeout || 2;
  client.read_timeout = config.read_timeout || 10;
  client.capacity = config.capacity || 1000;
  client.flush_interval = config.flush_interval || 5;  
  client.api_key = api_key;
  client.queue = [];
  client.offline = false;


  if (!api_key) {
    throw new Error("You must configure the client with an API key");
  }

  requestify.cacheTransporter({
    cache: {},
    get: function(url, fn) {
      fn(null, cache[url]);
    },

    set: function(url, response, fn) {
      cache[url] = response;
      fn();
    },
    purge: function(url, fn) {
      delete cache[url];
      fn();
    }
  });

  client.get_flag = function(key, user, default_val, fn) {
    client.toggle(key, user, default_val, fn);
  }

  client.toggle = function(key, user, default_val, fn) {
    var cb = fn || noop;

    if (this.offline) {
      cb(null, default_val);
    }

    else if (!key) {
      send_flag_event(client, key, user, default_val);
      cb(new Error("[LaunchDarkly] No flag key specified in toggle call"), default_val);
    }

    else if (!user) {
      send_flag_event(client, key, user, default_val);
      cb(new Error("[LaunchDarkly] No user specified in toggle call"), default_val);
    }

    else {
      requestify.request(this.base_uri + '/api/eval/features/' + key, {
        method: "GET",
        headers: {
          'Authorization': 'api_key ' + this.api_key,
          'User-Agent': 'NodeJSClient/' + VERSION
        },
        timeout: this.timeout * 1000
      })
      .then(function(response) {      
        var result = evaluate(response.getBody(), user);
        if (result == null) {
          send_flag_event(client, key, user, default_val);
          cb(null, default_val);
        } else {
          send_flag_event(client, key, user, result);
          cb(null, result);
        }
      },
      function(error) {
        cb(error, default_val);
      });
    }

  }

  client.set_offline = function() {
    this.offline = true; 
  }

  client.set_online = function() {
    this.offline = false;
  }

  client.is_offline = function() {
    return this.offline;
  }

  client.track = function(eventName, user, data) {
    var event = {"key": eventName, 
                "user": user,
                "kind": "custom", 
                "creationDate": new Date().getTime()};

    if (data) {
      event.data = data;
    }

    enqueue(client, event);
  }

  client.identify = function(user) {
    var event = {"key": user.key,
                 "kind": "identify",
                 "user": user,
                 "creationDate": new Date().getTime()};
    enqueue(client, event);
  }

  client.flush = function(fn) {
    var cb = fn || noop;
    var worklist;
    if (!this.queue.length) {
      return process.nextTick(cb);
    }

    worklist = this.queue.slice(0);
    this.queue = [];

    requestify.request(this.base_uri + '/api/events/bulk', {
      method: "POST",
      headers: {
        'Authorization': 'api_key ' + this.api_key,
        'User-Agent': 'NodeJSClient/' + VERSION,
        'Content-Type': 'application/json'
      },
      body: worklist,
      timeout: this.timeout * 1000
    })
    .then(function(response) {
      cb(null, response);
    }, function(error) {
      cb(error, null);
    });


  }

  setInterval(client.flush.bind(client), client.flush_interval * 1000).unref();

  return client;
};

module.exports = {
  init: new_client
}

function enqueue(client, event) {
  if (client.offline) {
    return;
  }

  client.queue.push(event);

  if (client.queue.length >= client.capacity) {
    client.flush();
  } 
}

function send_flag_event(client, key, user, value) {
  var event = {
    "kind": "feature",
    "key": key,
    "user": user,
    "value": value,
    "creationDate": new Date().getTime()
  }

  enqueue(client, event);
}


function param_for_user(feature, user) {
  var idHash, hashKey, hashVal, result;
  
  if (user.key) {
    idHash = user.key;
  }

  if (user.secondary) {
    idHash += "." + user.secondary;
  }

  hashKey = util.format("%s.%s.%s", feature.key, feature.salt, idHash);
  hashVal = parseInt(sha1(hashKey).substring(0,15), 16)

  result = hashVal / 0xFFFFFFFFFFFFFFF
  return result
}

var builtins = ['key', 'ip', 'country', 'email', 'firstName', 'lastName', 'avatar', 'name', 'anonymous'];

function match_target(target, user) {
  var uValue;
  var attr = target.attribute;

  if (builtins.indexOf(attr) >= 0) {
    uValue = user[attr];
    if (uValue) {
      return target.values.indexOf(uValue) >= 0;
    }
    else {
      return false;
    }
  }
  else { // custom attribute
    if (!user.custom) {
      return false;
    }
    if (!user.custom.hasOwnProperty(attr)) {
      return false;
    }
    uValue = user.custom[attr];

    if (uValue instanceof Array) {
      return intersect_safe(uValue, target.values).length > 0;
    }
    return target.values.indexOf(uValue) >= 0;
  }
}

function match_user(variation, user) {
  if (variation.userTarget) {
    return match_target(variation.userTarget, user);
  }
  return false;
}

function match_variation(variation, user) {
  for (i = 0; i < variation.targets.length; i++) {
    if (variation.userTarget && variation.targets[i].attribute === 'key') {
      continue;
    }

    if (match_target(variation.targets[i], user)) {
      return true;
    }
  }
  return false;
}

function evaluate(feature, user) {
  if (!feature.on) {
    return null;
  }

  param = param_for_user(feature, user);

  if (!param) {
    return null;
  }

  for (var i = 0; i < feature.variations.length; i ++) {
    if (match_user(feature.variations[i], user)) {
      return feature.variations[i].value;
    }
  }  

  for (var i = 0; i < feature.variations.length; i ++) {
    if (match_variation(feature.variations[i], user)) {
      return feature.variations[i].value;
    }
  }

  var total = 0.0;   
  for (var i = 0; i < feature.variations.length; i++) {
    total += feature.variations[i].weight / 100.0
    if (param < total) {
      return feature.variations[i].value;
    }
  }

  return null;
}

function intersect_safe(a, b)
{
  return a.filter(function(value) {
    return b.indexOf(value) > -1;
  });
}
