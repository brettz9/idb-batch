import 'babel-polyfill' // Array.prototype.values, etc.

import isPlainObj from 'is-plain-obj'
import isSafari from 'is-safari'
import SyncPromise from 'sync-promise'

/**
 * Links to array prototype methods.
 */

const slice = [].slice
const map = [].map

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

export default function batch(db, storeName, ops, opts) {
  if (typeof storeName !== 'string') throw new TypeError('invalid "storeName"')
  if (![3, 4].includes(arguments.length)) throw new TypeError('invalid arguments length')
  validateAndCanonicalizeOps(ops)
  return transactionalBatch(db, { [storeName]: ops }, opts).then((arr) => arr[0].map((obj) => obj[storeName]))
}

export function getStoreNames(storeOpsArr) {
  if (isPlainObj(storeOpsArr)) storeOpsArr = [storeOpsArr]
  return storeOpsArr.reduce((storeNames, opObj) => {
    // This has no effect if the opObj is a function
    return storeNames.concat(Object.keys(opObj))
  }, [])
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
 * @property {Boolean} opts.parallel=false Whether or not to load in parallel
 * @property {Array} opts.extraStores=[]] A list of store names to add to the transaction (when `tr` is an `IDBDatabase` object)
 * @return {Promise} Resolves to an array containing the results of the operations for each store
 */

export function transactionalBatch(tr, storeOpsArr, opts = { parallel: false, extraStores: [] }) {
  if (![2, 3].includes(arguments.length)) throw new TypeError('invalid arguments length')
  if (isPlainObj(storeOpsArr)) storeOpsArr = [storeOpsArr]
  const storeOpsArrIter = storeOpsArr.values()
  if (typeof tr.createObjectStore === 'function') {
    tr = tr.transaction(getStoreNames(storeOpsArr).concat(opts.extraStores), 'readwrite')
  }
  return new SyncPromise((resolve, reject) => {
    const results = []
    tr.onerror = handleError(reject)
    tr.oncomplete = () => resolve(results)

    if (opts.parallel) {
      return
    }

    let iterateStoreOps
    const iterateStores = (storeOpsVals, storeOpsObj) => {
      if (typeof storeOpsObj === 'function') {
        storeOpsObj(tr)
        iterateStoreOps()
        return
      }
      const storeOpIter = storeOpsVals.next()
      if (storeOpIter.done) {
        iterateStoreOps()
        return
      }
      const storeName = storeOpIter.value
      const storeResults = []

      let ops = storeOpsObj[storeName]
      try {
        ops = validateAndCanonicalizeOps(ops)
      } catch (err) {
        reject(err)
        return
      }

      const store = tr.objectStore(storeName)
      let currentIndex = 0

      next()

      function next() {
        const { type, key } = ops[currentIndex]
        if (type === 'clear') {
          request(storeName, store.clear())
          return
        }
        if (type === 'del') {
          request(storeName, store.delete(key))
          return
        }
        const val = ops[currentIndex].val || ops[currentIndex].value
        if (['move', 'copy'].includes(type)) {
          const req = store.get(val)
          req.onerror = handleError(reject)
          req.onsuccess = (e) => {
            ops.splice(currentIndex, 0, { type: 'put', key, value: e.target.result })
            if (type === 'move') {
              ops.splice(currentIndex + 1, 0, { type: 'delete', key: val })
            }
            next()
          }
          return
        }
        if (key && store.keyPath) val[store.keyPath] = key

        countUniqueIndexes(store, key, val, (err, uniqueRecordsCounter) => {
          if (err) return reject(err)

          // We don't abort transaction here (we just stop execution)
          // Browsers' implementations also don't abort, and instead just throw an error
          if (uniqueRecordsCounter) return reject(new Error('Unique index ConstraintError'))
          request(storeName, store.keyPath ? store[type](val) : store[type](val, key))
        })
      }

      function request(storeNm, req) {
        currentIndex++

        req.onerror = handleError(reject)
        req.onsuccess = (e) => {
          storeResults.push({ [storeNm]: e.target.result })
          if (currentIndex < ops.length) next()
          else {
            results.push(storeResults)
            iterateStores(storeOpsVals, storeOpsObj)
          }
        }
      }
    }

    iterateStoreOps = () => {
      let storeOpsObj = storeOpsArrIter.next()
      if (storeOpsObj.done) {
        return
      }
      storeOpsObj = storeOpsObj.value
      const storeOpsVals = Object.keys(storeOpsObj).values()
      iterateStores(storeOpsVals, storeOpsObj)
    }
    iterateStoreOps()
  })
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
  if (!isSafari && global.indexedDB !== global.shimIndexedDB) return cb()

  const indexes = slice.call(store.indexNames).map((indexName) => {
    const index = store.index(indexName)
    const indexVal = isCompound(index)
    ? map.call(index.keyPath, (indexKey) => val[indexKey]).filter((v) => v)
    : val[index.keyPath]

    return [index, indexVal]
  }).filter(([index, indexVal]) => {
    return index.unique && (isCompound(index) ? indexVal.length : indexVal)
  })

  if (!indexes.length) return cb()

  let totalRequestsCounter = indexes.length
  let uniqueRecordsCounter = 0

  indexes.forEach(([index, indexVal]) => {
    const req = index.getKey(indexVal) // get primaryKey to compare with updating value
    req.onerror = handleError(cb)
    req.onsuccess = (e) => {
      if (e.target.result && e.target.result !== key) uniqueRecordsCounter++
      totalRequestsCounter--
      if (totalRequestsCounter === 0) cb(null, uniqueRecordsCounter)
    }
  })
}

/**
 * Check if `index` is compound
 *
 * @param {IDBIndex} index
 * @return {Boolean}
 */

function isCompound(index) {
  return typeof index.keyPath !== 'string'
}

/**
 * Create error handler.
 *
 * @param {Function} cb
 * @return {Function}
 */

function handleError(cb) {
  return (e) => {
    // prevent global error throw https://bugzilla.mozilla.org/show_bug.cgi?id=872873
    if (typeof e.preventDefault === 'function') e.preventDefault()
    cb(e.target.error)
  }
}

/**
 * Validate operations and canonicalize them into an array.
 *
 * @param {Array|Object} ops
 * @return {Array} Canonicalized operations array
 */

function validateAndCanonicalizeOps(ops) {
  if (ops === 'clear') {
    ops = [{ type: 'clear' }]
  }
  if (!Array.isArray(ops) && !isPlainObj(ops)) {
    throw new TypeError('invalid "ops"')
  }
  if (isPlainObj(ops)) {
    ops = Object.keys(ops).map((key) => {
      return { key, value: ops[key], type: ops[key] === null ? 'del' : 'put' }
    })
  }
  ops.forEach((op) => {
    if (!isPlainObj(op)) throw new TypeError('invalid op')
    if (['add', 'put', 'del', 'move', 'copy', 'clear'].indexOf(op.type) === -1) throw new TypeError(`invalid type "${op.type}"`)
  })
  return ops
}
