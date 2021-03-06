var express = require('express'),
path = require('path'),
logger = require("../logging"),
config = require('../config'), 
util = require('../util'),      
sprintf = require('sprintf-js').sprintf,  
Q = require('q'),
solr = require('solr-client'),
url = require('url');

module.exports = function(router, io) {
  router.set('views', path.join(__dirname, '../views'));
  router.set('view engine', 'jade');  
  
  router.get('/proxy/*', function(req, res, next) {
  
    var promise = [];     
    var query = url.parse(req.url, true).query;            
    
    if (util.validateRequest(req, url, config) &&
      config.proxy.mapping[url.parse(req.params[0], true).pathname] !== undefined) {
      
      logger.info('ALLOWED: ' + req.method + ' ' + req.url);
      var connector;
      // proxing request
      connector = config.proxy.mapping[url.parse(req.params[0], true).pathname]; 
      promise.push(connector.handler(query, false));         
                   
    }else {
      logger.info('DENIED: ' + req.method + ' ' + req.url);
      res.writeHead(403, 'Illegal request');
      res.write('solrProxy: access denied\n');
      res.end();
    } 
    
    Q.allSettled(promise).then(function(result) {
        //loop through array of promises, add items  
        var tosend = [];
        var jsonResponse = {};
        
        result.forEach(function(prom) {
            if (prom.state === "fulfilled") {
                //res.write("-- SUCCESS: " + prom.value);
                var key = extract_result_key(prom.value);
                jsonResponse[key] = prom.value[key];
            }
            if (prom.state === "rejected") {
                //res.write("-- ERROR: " + prom.reason);
                var key = extract_result_key(prom.reason);
                jsonResponse[key] = prom.reason[key].message;
                
            }
        });
        promise = []; //empty array, since it's global.        
        res.jsonp(jsonResponse);
    });     
    
    var extract_result_key = function(result) {
      var keys = [];
      for (var key in result) {
        if (result.hasOwnProperty(key)) {
          keys.push(key);
        }
      }      
      return keys;    
    };
  });
}
