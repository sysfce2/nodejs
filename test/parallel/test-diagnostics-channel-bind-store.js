'use strict';

const common = require('../common');
const assert = require('assert');
const dc = require('diagnostics_channel');
const { AsyncLocalStorage } = require('async_hooks');

let n = 0;
const thisArg = new Date();
const inputs = [
  { foo: 'bar' },
  { baz: 'buz' }
];

const channel = dc.channel('test');

// Bind a storage directly to published data
const store1 = new AsyncLocalStorage();
channel.bindStore(store1);

// Bind a store with transformation of published data
const store2 = new AsyncLocalStorage();
channel.bindStore(store2, common.mustCall((data) => {
  assert.deepStrictEqual(data, inputs[n]);
  return { data };
}, 2));

// Regular subscribers should see publishes from runStores calls
channel.subscribe(common.mustCall((data) => {
  assert.deepStrictEqual(data, inputs[n]);
}, 2));

// Verify stores are empty before run
assert.deepStrictEqual(store1.getStore(), undefined);
assert.deepStrictEqual(store2.getStore(), undefined);

channel.runStores(inputs[n], common.mustCall(function (a, b) {
  // Verify this and argument forwarding
  assert.deepStrictEqual(this, thisArg);
  assert.strictEqual(a, 1);
  assert.strictEqual(b, 2);

  // Verify store 1 state matches input
  assert.deepStrictEqual(store1.getStore(), inputs[n]);

  // Verify store 2 state has expected transformation
  assert.deepStrictEqual(store2.getStore(), { data: inputs[n] });
}), thisArg, 1, 2);

// Verify stores are empty after run
assert.deepStrictEqual(store1.getStore(), undefined);
assert.deepStrictEqual(store2.getStore(), undefined);

// Verify unbinding works
assert.ok(channel.unbindStore(store1));

// Verify unbinding a store that is not bound returns false
assert.ok(!channel.unbindStore(store1));

n++
channel.runStores(inputs[n], common.mustCall(() => {
  // Verify after unbinding store 1 will remain undefined
  assert.deepStrictEqual(store1.getStore(), undefined);

  // Verify still bound store 2 receives expected data
  assert.deepStrictEqual(store2.getStore(), { data: inputs[n] });
}));
