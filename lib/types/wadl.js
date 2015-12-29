'use strict';

var _ = require('lodash');
var assert = require('assert');
var XMLParser = require('xml2js').parseString;
var Inherits = require('util').inherits;
var Path = require('path');
var URI = require('urijs');

var BaseType = require('../base-type.js');
var Util = require('../util.js');

var WADL = module.exports = function() {
  WADL.super_.apply(this, arguments);
  this.converters = {};
  this.converters.swagger_2 = function(wadl, callback) {
    try {
      var swagger2 = convertToSwagger(wadl.spec);
    } catch(e) {
      return callback(e);
    }
    return callback(null, swagger2);
  }
}

Inherits(WADL, BaseType);

WADL.prototype.formatName = 'wadl';
WADL.prototype.supportedVersions = ['1.0'];
WADL.prototype.getFormatVersion = function () {
  return '1.0';
}

WADL.prototype.parsers = [function(string, cb) {
  XMLParser(string, cb);
}];

WADL.prototype.checkFormat = function (spec) {
  return true;
}

function convertToSwagger(wadl, callback) {
  var convertStyle = function(style) {
    switch (style) {
      case 'query':
      case 'header':
        return style;
      case 'template':
        return 'path';
      default:
        assert(false);
    }
  }
  var convertType = function(wadlType) {
    if (_.isUndefined(wadlType))
      return {};

    //HACK: we just strip namespace. Yes I know, it's ugly.
    //But handling XML namespaces is even uglier.
    var match = wadlType.match('^[^:]\+:(.+)$');
    assert(match);
    var type = match[1];
    switch (type) {
      case 'boolean':
      case 'string':
      case 'integer':
        return {type: type};
      case 'double':
        return {type: "number"};
      case 'int':
        return {type: "integer", minimum: -2147483648, maximum: 2147483647};
      case 'long':
        return {type: "integer", minimum: -9223372036854775808, maximum: 9223372036854775807};
      case 'positiveInteger':
        return {type: "integer", minimum: 1};
      default:
        assert(false, 'Unsupported type: ' + wadlType);
    }
  }

  var convertDoc = function (doc) {
    if (_.isUndefined(doc))
      return {};

    assert(_.isArray(doc));
    var result = {};
    _.each(doc, function (docElement) {
      if (_.isPlainObject(docElement)) {
        var externalUrl = docElement.$['apigee:url'];
        if (externalUrl)
          result.externalDocs = {url: externalUrl};
        docElement = docElement._;
        if (!_.isString(docElement))
          return;
      }

      assert(_.isString(docElement));
      docElement = docElement.trim();
      if (result.description)
        result.description += '\n' + docElement;
      else
        result.description = docElement;
    });
    return result;
  }

  var convertDefault = function (wadlDefault, type) {
    if (type === 'string')
      return wadlDefault;
    return JSON.parse(wadlDefault);
  }

  var convertParameter = function(wadlParam) {
    var ret = {
      name: wadlParam.$.name,
      required: JSON.parse(wadlParam.$.required || 'false'),
      in: convertStyle(wadlParam.$.style),
      type: 'string', //default type
    };
    _.assign(ret, convertType(wadlParam.$.type));

    var wadlDefault = wadlParam.$.default;
    if (!_.isUndefined(wadlDefault))
      ret.default = convertDefault(wadlDefault, ret.type);

    var doc = convertDoc(wadlParam.doc);
    //FIXME:
    delete doc.externalDocs;
    _.extend(ret,doc);

    if (wadlParam.option) {
      ret.enum = wadlParam.option.map(function(opt) {
        return opt.$.value;
      })
    }
    return ret;
  }

  function unwrapArray(array) {
    if (_.isUndefined(array))
      return;

    assert(_.isArray(array));
    assert(_.size(array) === 1);
    return array[0];
  }

  function convertMethod(wadlMethod) {
    var method = {
      operationId: wadlMethod.$.id,
      responses: {
        //FIXME: take responces from WADL file
        200: {
          description: 'Successful Response'
        }
      }
    };

    var wadlRequest = unwrapArray(wadlMethod.request);
    if (wadlRequest)
      method.parameters = _.map(wadlRequest.param, convertParameter);

    _.extend(method, convertDoc(wadlMethod.doc));

    return method;
  }

  function convertResource(wadlResource) {
    var resourcePath = Path.join('/', wadlResource.$.path);
    var paths = {};

    //Not supported
    assert(!_.has(wadlResource, 'resource_type'));
    assert(!_.has(wadlResource, 'resource_type'));

    var resource = {};
    var commonParameters = _.map(wadlResource.param, convertParameter);

    _.each(wadlResource.method, function(wadlMethod) {
      var httpMethod = wadlMethod.$.name.toLowerCase();
      resource[httpMethod] = convertMethod(wadlMethod);
    });

    if (!_.isEmpty(resource)) {
      resource.parameters = commonParameters;
      paths[resourcePath] = resource;
    }

    _.each(wadlResource.resource, function (wadlSubResource) {
      var subPaths = convertResource(wadlSubResource);
      subPaths = _.mapKeys(subPaths, function (subPath, path) {
        subPath.parameters = commonParameters.concat(subPath.parameters);
        return Path.join(resourcePath, path);
      });
      mergePaths(paths, subPaths);
    });

    return paths;
  }

  function mergePaths(paths, pathsToAdd) {
    _.each(pathsToAdd, function (resource, path) {
      var existingResource = paths[path];
      if (!_.isUndefined(existingResource)) {
        assert(_.isEqual(existingResource.parameters, resource.parameters));
        _.extend(existingResource, resource);
      }
      else
        paths[path] = resource;
    });
  }

  var root = unwrapArray(wadl.application.resources);

  var baseUrl = URI(root.$.base);
  var swagger = {
    swagger: '2.0',
    host:  baseUrl.host(),
    basePath: baseUrl.pathname(),
    schemes: [baseUrl.protocol()],
    paths: {}
  };

  _.each(root.resource, function(wadlResource) {
    mergePaths(swagger.paths, convertResource(wadlResource));
  });

  return swagger;
}
