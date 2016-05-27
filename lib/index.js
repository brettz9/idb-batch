'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _slicedToArray = function () { function sliceIterator(arr, i) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i["return"]) _i["return"](); } finally { if (_d) throw _e; } } return _arr; } return function (arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { return sliceIterator(arr, i); } else { throw new TypeError("Invalid attempt to destructure non-iterable instance"); } }; }();

exports.default = batch;
exports.getStoreNames = getStoreNames;
exports.transactionalBatch = transactionalBatch;

require('babel-polyfill');

var _isPlainObj = require('is-plain-obj');

var _isPlainObj2 = _interopRequireDefault(_isPlainObj);

var _isSafari = require('is-safari');

var _isSafari2 = _interopRequireDefault(_isSafari);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _toConsumableArray(arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) { arr2[i] = arr[i]; } return arr2; } else { return Array.from(arr); } }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; } // Array.prototype.values, etc.

/**
 * Links to array prototype methods.
 */

var slice = [].slice;
var map = [].map;

/**
 * Perform batch operation for a single object store using `ops`.
 *
 * Array syntax:
 *
 * [
 *   { type: 'add', key: 'key1', val: 'val1' },
 *   { type: 'put', key: 'key2', val: 'val2' },
 *   { type: 'del', key: 'key3' },
 * ]
 *
 * Object syntax:
 *
 * {
 * 	 key1: 'val1', // put val1 to key1
 * 	 key2: 'val2', // put val2 to key2
 * 	 key3: null,   // delete key
 * }
 *
 * @param {Array|Object} ops Operations
 * @param {Object} opts See `transactionalBatch`
 * @return {Promise} Resolves to the result of the operations
 */

function batch(db, storeName, ops, opts) {
  if (typeof storeName !== 'string') return Promise.reject(new TypeError('invalid "storeName"'));
  if (![3, 4].includes(arguments.length)) return Promise.reject(new TypeError('invalid arguments length'));
  try {
    validateAndCanonicalizeOps(ops);
  } catch (err) {
    return Promise.reject(err);
  }
  return transactionalBatch(db, _defineProperty({}, storeName, ops), opts).then(function (arr) {
    return arr[0][storeName];
  });
}

function getStoreNames(storeOpsArr) {
  if ((0, _isPlainObj2.default)(storeOpsArr)) storeOpsArr = [storeOpsArr];
  return storeOpsArr.reduce(function (storeNames, opObj) {
    // This has no effect if the opObj is a function
    return storeNames.concat(Object.keys(opObj));
  }, []);
}

/**
 * Perform batch operations for any number of object stores using `ops`.
 *
 * Array syntax:
 *
 * [
 *   { type: 'add', key: 'key1', val: 'val1' },
 *   { type: 'put', key: 'key2', val: 'val2' },
 *   { type: 'del', key: 'key3' },
 * ]
 *
 * Object syntax:
 *
 * {
 * 	 key1: 'val1', // put val1 to key1
 * 	 key2: 'val2', // put val2 to key2
 * 	 key3: null,   // delete key
 * }
 *
 * @param {IDBDatabase|IDBTransaction} tr IndexedDB database or transaction on which the batch will operate
 * @param {Array|Object} storeOpsArr Array of objects (or a single object) whose keys are store names and objects are idb-batch operations (object or array)
 * @param {Object} [opts] Options object
 * @property {Boolean} [opts.parallel=false] Whether or not to load in parallel
 * @property {Boolean} [opts.resolveEarly=false] Whether or not to resolve the promise before the transaction ends
 * @property {Array} [opts.extraStores=[]] A list of store names to add to the transaction (when `tr` is an `IDBDatabase` object)
 * @property {Function} [opts.adapterCb=null] A callback which will be supplied the `tr` and function of a function-type operation)
 * @return {Promise} Resolves to an array containing the results of the operations for each store
 */

function transactionalBatch(tr, storeOpsArr) {
  var opts = arguments.length <= 2 || arguments[2] === undefined ? { parallel: false, extraStores: [], resolveEarly: false, adapterCb: null } : arguments[2];

  if (![2, 3].includes(arguments.length)) return Promise.reject(new TypeError('invalid arguments length'));
  if ((0, _isPlainObj2.default)(storeOpsArr)) storeOpsArr = [storeOpsArr];
  var storeOpsArrIter = storeOpsArr.keys();
  opts = opts || {};
  if (typeof tr.createObjectStore === 'function') {
    tr = tr.transaction(getStoreNames(storeOpsArr).concat(opts.extraStores || []), 'readwrite');
  }
  return new Promise(function (resolve, reject) {
    var results = [];
    tr.addEventListener('error', handleError(reject));
    tr.addEventListener('abort', handleError(reject));
    if (!opts.resolveEarly) tr.addEventListener('complete', function () {
      return resolve(results);
    });

    var iterateStoreOps = void 0;
    var iterateStores = function iterateStores(ct, storeResults, storeNames, storeOpsKeys, storeOpsObj, serial) {
      if (typeof storeOpsObj === 'function') {
        var ret = void 0;
        try {
          ret = opts.adapterCb ? opts.adapterCb(tr, storeOpsObj) : storeOpsObj(tr);
        } catch (err) {
          reject(err);
          return;
        }
        results[ct] = ret;
        if (serial) {
          if (ret && ret.then) {
            ret.then(iterateStoreOps);
            return;
          }
          iterateStoreOps();
        }
        return;
      }
      var storeOpIter = storeOpsKeys.next();
      if (storeOpIter.done) {
        if (serial) iterateStoreOps();
        return;
      }
      var idx = storeOpIter.value;
      var storeName = storeNames[idx];
      var moveCt = 0;
      var successCt = 0;

      var ops = storeOpsObj[storeName];
      try {
        ops = validateAndCanonicalizeOps(ops);
      } catch (err) {
        reject(err);
        return;
      }

      var store = tr.objectStore(storeName);

      if (serial) {
        next(ct, 0);
      } else {
        for (var i = 0; i < ops.length; i++) {
          next(ct, i);
        }
        iterateStores(ct, storeResults, storeNames, storeOpsKeys, storeOpsObj);
      }

      function next(storeOpsIdx, opIndex) {
        var _ops$opIndex = ops[opIndex];
        var type = _ops$opIndex.type;
        var key = _ops$opIndex.key;

        if (type === 'clear') {
          request(storeOpsIdx, opIndex, storeName, store.clear());
          return;
        }
        if (type === 'del') {
          request(storeOpsIdx, opIndex, storeName, store.delete(key));
          return;
        }
        var val = ops[opIndex].val || ops[opIndex].value;
        if (['move', 'copy'].includes(type)) {
          var req = store.get(val);
          req.onerror = handleError(reject);
          req.onsuccess = function (e) {
            ops.splice(opIndex, 1, { type: 'put', key: key, value: e.target.result });
            if (type === 'move') {
              if (!serial) moveCt++;
              ops.splice(opIndex + 1, 0, { type: 'del', key: val });
            }
            next(storeOpsIdx, opIndex);
            if (!serial && type === 'move') next(storeOpsIdx, opIndex + 1);
          };
          return;
        }
        if (key && store.keyPath) val[store.keyPath] = key;

        countUniqueIndexes(store, key, val, function (err, uniqueRecordsCounter) {
          if (err) return reject(err);

          // We don't abort transaction here (we just stop execution)
          // Browsers' implementations also don't abort, and instead just throw an error
          if (uniqueRecordsCounter) return reject(new Error('Unique index ConstraintError'));
          request(storeOpsIdx, opIndex, storeName, store.keyPath ? store[type](val) : store[type](val, key));
        });
      }

      function request(storeOpsIdx, opIndex, storeNm, req) {
        req.onerror = handleError(reject);
        req.onsuccess = function (e) {
          if (!storeResults[storeNm]) {
            storeResults[storeNm] = [];
          }
          storeResults[storeNm][successCt++] = e.target.result;
          if (successCt === ops.length - moveCt) {
            results[storeOpsIdx] = storeResults;
            if (serial) iterateStores(ct, storeResults, storeNames, storeOpsKeys, storeOpsObj, serial);
          } else if (serial) {
            next(storeOpsIdx, ++opIndex);
          }
        };
      }
    };

    iterateStoreOps = opts.parallel ? function () {
      for (var storeOpsObj = storeOpsArrIter.next(); !storeOpsObj.done; storeOpsObj = storeOpsArrIter.next()) {
        var val = storeOpsObj.value;
        storeOpsObj = storeOpsArr[val];
        var storeNames = Object.keys(storeOpsObj);
        var storeOpsKeys = storeNames.keys();
        iterateStores(val, {}, storeNames, storeOpsKeys, storeOpsObj);
      }
      if (opts.resolveEarly) resolve(results);
    } : function () {
      var storeOpsObj = storeOpsArrIter.next();
      if (storeOpsObj.done) {
        if (opts.resolveEarly) resolve(results);
        return;
      }
      var val = storeOpsObj.value;
      storeOpsObj = storeOpsArr[val];
      var storeNames = Object.keys(storeOpsObj);
      var storeOpsKeys = storeNames.keys();
      iterateStores(val, {}, storeNames, storeOpsKeys, storeOpsObj, true);
    };
    iterateStoreOps();
  });
}

/**
 * Validate unique index manually.
 *
 * Fixing:
 * - https://bugs.webkit.org/show_bug.cgi?id=149107
 * - https://github.com/axemclion/IndexedDBShim/issues/56
 *
 * @param {IDBStore} store
 * @param {Any} val
 * @param {Function} cb(err, uniqueRecordsCounter)
 */

function countUniqueIndexes(store, key, val, cb) {
  // rely on native support
  if (!_isSafari2.default && global.indexedDB !== global.shimIndexedDB) return cb();

  var indexes = slice.call(store.indexNames).map(function (indexName) {
    var index = store.index(indexName);
    var indexVal = isCompound(index) ? map.call(index.keyPath, function (indexKey) {
      return val[indexKey];
    }).filter(function (v) {
      return v;
    }) : val[index.keyPath];

    return [index, indexVal];
  }).filter(function (_ref) {
    var _ref2 = _slicedToArray(_ref, 2);

    var index = _ref2[0];
    var indexVal = _ref2[1];

    return index.unique && (isCompound(index) ? indexVal.length : indexVal);
  });

  if (!indexes.length) return cb();

  var totalRequestsCounter = indexes.length;
  var uniqueRecordsCounter = 0;

  indexes.forEach(function (_ref3) {
    var _ref4 = _slicedToArray(_ref3, 2);

    var index = _ref4[0];
    var indexVal = _ref4[1];

    var req = index.getKey(indexVal); // get primaryKey to compare with updating value
    req.onerror = handleError(cb);
    req.onsuccess = function (e) {
      if (e.target.result && e.target.result !== key) uniqueRecordsCounter++;
      totalRequestsCounter--;
      if (totalRequestsCounter === 0) cb(null, uniqueRecordsCounter);
    };
  });
}

/**
 * Check if `index` is compound
 *
 * @param {IDBIndex} index
 * @return {Boolean}
 */

function isCompound(index) {
  return typeof index.keyPath !== 'string';
}

/**
 * Create error handler.
 *
 * @param {Function} cb
 * @return {Function}
 */

function handleError(cb) {
  return function (e) {
    // prevent global error throw https://bugzilla.mozilla.org/show_bug.cgi?id=872873
    if (typeof e.preventDefault === 'function') e.preventDefault();
    cb(e.target.error);
  };
}

/**
 * Validate operations and canonicalize them into an array.
 *
 * @param {Array|Object} ops
 * @return {Array} Canonicalized operations array
 */

function validateAndCanonicalizeOps(ops) {
  if (ops === 'clear') {
    ops = [{ type: 'clear' }];
  }
  if (!Array.isArray(ops) && !(0, _isPlainObj2.default)(ops)) {
    throw new TypeError('invalid "ops"');
  }
  if ((0, _isPlainObj2.default)(ops)) {
    ops = Object.keys(ops).map(function (key) {
      return { key: key, value: typeof ops[key] === 'string' ? ops[key].replace(/^\0/, '') : ops[key], type: ops[key] === '\0' ? 'del' : 'put' };
    });
  }
  function checkOp(op) {
    if (['add', 'put', 'del', 'move', 'copy', 'clear'].indexOf(op.type) === -1) throw new TypeError('invalid type "' + op.type + '"');
  }
  ops.forEach(function (op, i) {
    if (!(0, _isPlainObj2.default)(op)) throw new TypeError('invalid op');
    var opKeys = Object.keys(op);
    var type = opKeys[0];
    if (opKeys.length === 1 && type !== 'type') {
      var _ops;

      op = op[type];
      var opers = Array.isArray(op) ? op : [op];
      (_ops = ops).splice.apply(_ops, [i, 1].concat(_toConsumableArray(opers.map(function (oper) {
        Object.assign(oper, { type: type });
        checkOp(oper);
        return oper;
      }))));
      return;
    }
    checkOp(op);
  });
  return ops;
}