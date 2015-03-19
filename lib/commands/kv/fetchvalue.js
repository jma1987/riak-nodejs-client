/*
 * Copyright 2015 Basho Technologies, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var RpbGetReq = require('../../protobuf/riakprotobuf').getProtoFor('RpbGetReq');
var requestCode = require('../../protobuf/riakprotobuf').getCodeFor('RpbGetReq');
var expectedCode = require('../../protobuf/riakprotobuf').getCodeFor('RpbGetResp');
var RiakMeta = require('./riakmeta');
var KvResponseBase = require('./kvresponsebase');
var inherits = require('util').inherits;
var Joi = require('joi');

/**
 * Provides the FetchValue class, its builder, and its response.
 * @module FetchValue
 */

/**
 * Command used to fetch an object from Riak.
 * 
 * As a convenience, a builder class is provided:
 * 
 *     var FetchValue = require('lib/commands/fetchvalue');
 *     var fetch = new FetchValue.Builder()
 *         .withBucket('myBucket')
 *         .withKey('myKey')
 *         .withCallback(myCallback)
 *         .build();
 *      
 * 
 * @class FetchValue
 * @constructor
 * @param {Object} options
 * @param {String} [options.bucketType] the bucket type in riak.
 * @param {String} options.bucket the bucket in riak.
 * @param {String} options.key the key for the object you want to fetch.
 * @param {Function} options.callback the callback to be executed when the operation completes.
 * @param {String} options.callback.err An error message
 * @param {FetchValue.Response} options.callback.response - the response from Riak
 * @param {Number} [options.timeout] set a timeout for this operation.
 * @param {Number} [options.r] the R value to use for this fetch.
 * @param {Number} [options.pr] the PR value to use for this fetch.
 * @param {Boolean} [options.notFoundOk] if true a vnode returning notfound for a key increments the r tally.
 * @param {Boolean} [options.useBasicQuorum] controls whether a read request should return early in some fail cases.
 * @param {Boolean} [options.returnDeletedVClock] true to return tombstones
 * @param {Boolean} [options.headOnly] Return only the metadata.
 * @param {Buffer} [options.ifNotModified] Do not return the object if the supplied vclock matches. 
 * 
 */ 
function FetchValue(options) {
    
    var self = this;
    Joi.validate(options, schema, function(err, options) {
       
        if (err) {
            throw err;
        }
    
        self.protobuf = new RpbGetReq();
        self.protobuf.setBucket(new Buffer(options.bucket));
        self.protobuf.setType(new Buffer(options.bucketType));
        self.protobuf.setKey(new Buffer(options.key));
        
        if (options.hasOwnProperty('r')) {
            self.protobuf.setR(options.r);
        }
        if (options.hasOwnProperty('pr')) {
            self.protobuf.setPr(options.pr);
        }
        if (options.hasOwnProperty('notFoundOk')) {
            self.protobuf.setNotfoundOk(options.notFoundOk);
        }
        if (options.hasOwnProperty('useBasicQuorum')) {
            self.protobuf.setBasicQuorum(options.useBasicQuorum);
        }
        if (options.hasOwnProperty('returnDeletedVClock')) {
            self.protobuf.setDeletedvclock(options.returnDeletedVClock);
        }
        if (options.hasOwnProperty('headOnly')) {
            self.protobuf.setHead(options.headOnly);
        }
        if (options.hasOwnProperty('ifNotModified')) {
            self.protobuf.setIfModified(options.ifNotModified);
        }
        if (options.hasOwnProperty('timeout')) {
            self.protobuf.setTimeout(options.timeout);
        }
        
        self.callback = options.callback;
        self.bucket = options.bucket;
        self.key = options.key;
        self.bucketType = options.bucketType;
        
    });
    
    
    
    
    this.streaming = false;
    this.header = new Buffer(5);
    this.header.writeUInt8(requestCode, 4);
    this.remainingTries = 1;
}

FetchValue.prototype = {
    getRiakMessage : function() {
        var encoded = this.protobuf.encode().toBuffer();
        this.header.writeInt32BE(encoded.length + 1, 0);
        return {
            protobuf: encoded,
            header: this.header
        };
    },
    getExpectedResponseCode : function() {
        return expectedCode;
    },
    onSuccess : function(rpbGetResp) {
        
        // If the response is null ... it means not found. Riak only sends 
        // a message code and zero bytes when that's the case. 
        // Because that makes sense!
        if (rpbGetResp === null) {
            this.callback(null, new Response(true, false, []));
        } else {
            
            var pbContentArray = rpbGetResp.getContent();
            var vclock = rpbGetResp.getVclock().toBuffer();
            
            // To unify the behavior of having just a tombstone vs. siblings
            // that include a tombstone, we create an empty object and mark
            // it deleted
            if (pbContentArray.length === 0) {
                var riakMeta = new RiakMeta();
                
                var riakValue = new Buffer(0);
                riakMeta.isTombstone = true;
                riakMeta.key = this.key;
                riakMeta.bucket = this.bucket;
                riakMeta.bucketType = this.bucketType;
                this.callback(false, false, [{value: riakValue, meta: riakMeta}]);
            } else {
            
                var values = new Array(pbContentArray.length);

                for (var i = 0; i < pbContentArray.length; i++) {
                    var riakMeta = RiakMeta.extractMetaFromRpbContent(pbContentArray[i], vclock, this.bucketType, this.bucket, this.key);
                    var riakValue = pbContentArray[i].getValue().toBuffer();
                    values[i] = { value: riakValue, meta: riakMeta };
                }

                this.callback(null, new Response(false, false, values))
            }
        }
        
        return true;
    },
    onRiakError : function(rpbErrorResp) {
        this.onError(rpbErrorResp.getErrmsg().toString('utf8'));
    },
    onError : function(msg) {
        this.callback(msg, null);
    }
    
};

var schema = Joi.object().keys({
   bucket: joi.string().required(),
   bucketType: joi.string().default('default'),
   key: joi.string().required(),
   r: joi.number().optional(),
   pr: joi.numer().optional(),
   notFoundOk: joi.boolean().optional(),
   useBasicQuorum: joi.boolean().optional(),
   returnDeletedVClock: joi.boolean().default(false),
   headOnly: joi.boolean().default(false),
   ifNotModified: joi.binary().default(null),
   timeout: joi.number().default(null),
   callback: joi.func().required()
});

/**
 * A builder for constructing FetchValue instances.
 * * Rather than having to manually construct the __options__ and instantiating
 * a RiakNode directly, this builder may be used.
 * 
 *      var FetchValue = require('./lib/commands/fetchvalue');
 *      var fetchValue = new FetchValue.Builder().withBucket('myBucket').withKey('myKey').build();
 *       
 * @namespace FetchValue
 * @class Builder
 * @constructor
 */
function Builder() {}

Builder.prototype = {
  
    withBucket : function(bucket) {
        this.bucket = bucket;
        return this;
    },
    
    withBucketType : function(bucketType) {
        this.bucketType = bucketType;
        return this;
    },
    
    withKey : function(key) {
        this.key = key;
        return this;
    },
    
    /**
     * Set the R value for this FetchOperation.
     * If not asSet the bucket default is used.
     * @method withR
     * @param {Number} r the R value.
     * @return FetchValue.Builder
     */
    withR : function(r) {
        this.r = r;
        return this;
    },
    /**
    * Set the PR value for this query.
    * If not asSet the bucket default is used.
    * @method withPr
    * @param {Number} pr the PR value.
    * @return a reference to this object.
    */
    withPr : function(pr) {
        this.pr = pr;
        return this;
    },
    /**
    * Set the not_found_ok value.
    * If true a vnode returning notfound for a key increments the r tally.
    * False is higher consistency, true is higher availability.
    * If not asSet the bucket default is used.
    * @method withNotFoundOk
    * @param {Boolean} notFoundOk the not_found_ok value.
    * @return a reference to this object.
    */
    withNotFoundOk : function(notFoundOk) {
        this.notFoundOk = notFoundOk;
        return this;
    },
    /**
    * Set the basic_quorum value.
    * The parameter controls whether a read request should return early in
    * some fail cases. 
    * E.g. If a quorum of nodes has already
    * returned notfound/error, don't wait around for the rest.
    * @method withBasicQuorum
    * @param {Boolean} useBasicQuorum the basic_quorum value.
    * @return a reference to this object.
    */
    withBasicQuorum : function(useBasicQuorum) {
        this.useBasicQuorum = useBasicQuorum;
        return this;
    },
    /**
    * Set whether to return tombstones.
    * @method withReturnDeletedVClock
    * @param {Boolean} returnDeletedVClock true to return tombstones, false otherwise.
    * @return a reference to this object.
    */
    withReturnDeletedVClock : function(returnDeletedVClock) {
        this.returnDeletedVClock = returnDeletedVClock;
        return this;
    },
    /**
    * Return only the metadata.
    * Causes Riak to only return the metadata for the object. The value
    * will be asSet to null.
    * @method withHeadOnly
    * @param {Boolean} headOnly true to return only metadata. 
    * @return a reference to this object.
    */
    withHeadOnly : function(headOnly) {
        this.headOnly = headOnly;
        return this;
    },
    /**
    * Do not return the object if the supplied vclock matches. 
    * @method withIfNotModified
    * @param {Buffer} vclock the vclock to match on
    * @return a refrence to this object. 
    */
    withIfNotModified : function(vclock) {
        this.ifNotModified = vclock;
        return this;
    },
    /**
    * Set a timeout for this operation.
    * @method withTimeout
    * @param {Number} timeout a timeout in milliseconds.
    * @return a reference to this object.
    */
    withTimeout : function(timeout) {
        this.timeout = timeout;
        return this;
    },
    
    /**
     * Set the callback to be executed when the operation completes.
     * @param {Function} callback - the callback to execute
     * @param {String} callback.err An error message
     * @param {FetchValue.Response} callback.response - the response from Riak
     * @return {FetchValue.Builder}
     */
    withCallback : function(callback) {
        this.callback = callback;
        return this;
    },
    
    /**
     * Construct a FetchValue command.
     * @method build
     * @return {FetchValue}
     */
    build : function() {
        return new FetchValue(this);
    }
        
};

/**
 * The response from a FetchValue command.
 * @namespace FetchValue
 * @class Response
 * @constructor
 * @param {Boolean} notFound if the response was not found.
 * @param {Boolean} unchanged if the response was unchanged.
 * @param {Object[]} rawResponse array of value/meta pairs from Riak.
 * @param {Buffer} rawResponse.value The value portion
 * @param {RiakMeta} rawResponse.meta The metadata
 * @extends KvResponseBase
 */
function Response(notFound, unchanged, rawResponse) {
    
    KvResponseBase.call(this,rawResponse);
    this.notFound = notFound;
    this.unchanged = unchanged;
}

inherits(Response, KvResponseBase);

Response.prototype.isNotFound = function() {
    return this.notFound;
};

Response.prototype.isUnchanged = function() {
    return this.unchanged;
};


module.exports = FetchValue;
module.exports.Builder = Builder;