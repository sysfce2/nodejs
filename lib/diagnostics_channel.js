'use strict';

const {
  ArrayPrototypeIndexOf,
  ArrayPrototypePush,
  ArrayPrototypeSplice,
  FunctionPrototypeBind,
  ObjectCreate,
  ObjectGetPrototypeOf,
  ObjectSetPrototypeOf,
  PromisePrototypeThen,
  ReflectApply,
  SymbolHasInstance,
} = primordials;

const {
  codes: {
    ERR_INVALID_ARG_TYPE,
  }
} = require('internal/errors');
const {
  validateFunction,
} = require('internal/validators');

const { triggerUncaughtException } = internalBinding('errors');

const { WeakReference } = internalBinding('util');

function decRef(channel) {
  channel._weak.decRef();
  if (channel._weak.getRef() === 0) {
    delete channels[channel.name];
  }
}

function markActive(channel) {
  ObjectSetPrototypeOf(channel, ActiveChannel.prototype);
  channel._subscribers = [];
  channel._stores = new Map();
}

function maybeMarkInactive(channel) {
  // When there are no more active subscribers, restore to fast prototype.
  if (!channel._subscribers.length && !channel._stores.size) {
    // eslint-disable-next-line no-use-before-define
    ObjectSetPrototypeOf(channel, Channel.prototype);
    channel._subscribers = undefined;
    channel._stores = undefined;
  }
}

// TODO(qard): should there be a C++ channel interface?
class ActiveChannel {
  subscribe(subscription) {
    validateFunction(subscription, 'subscription');
    ArrayPrototypePush(this._subscribers, subscription);
    this._weak.incRef();
  }

  unsubscribe(subscription) {
    const index = ArrayPrototypeIndexOf(this._subscribers, subscription);
    if (index === -1) return false;

    ArrayPrototypeSplice(this._subscribers, index, 1);

    decRef(this);
    maybeMarkInactive(this);

    return true;
  }

  bindStore(store, transform) {
    const replacing = this._stores.has(store);
    this._stores.set(store, transform);
    if (!replacing) {
      this._weak.incRef();
    }
  }

  unbindStore(store) {
    if (!this._stores.has(store)) {
      return false;
    }

    this._stores.delete(store);

    decRef(this);
    maybeMarkInactive(this);

    return true;
  }

  get hasSubscribers() {
    return true;
  }

  publish(data) {
    for (let i = 0; i < this._subscribers.length; i++) {
      try {
        const onMessage = this._subscribers[i];
        onMessage(data, this.name);
      } catch (err) {
        process.nextTick(() => {
          triggerUncaughtException(err, false);
        });
      }
    }
  }

  runStores(data, fn, thisArg, ...args) {
    this.publish(data);

    // Bind base fn first due to AsyncLocalStorage.run not having thisArg
    fn = FunctionPrototypeBind(fn, thisArg, ...args);

    for (const [ store, transform ] of this._stores.entries()) {
      fn = wrapStoreRun(store, data, fn, transform);
    }

    return fn();
  }
}

class Channel {
  constructor(name) {
    this._subscribers = undefined;
    this._stores = undefined;
    this._weak = undefined;
    this.name = name;
  }

  static [SymbolHasInstance](instance) {
    const prototype = ObjectGetPrototypeOf(instance);
    return prototype === Channel.prototype ||
           prototype === ActiveChannel.prototype;
  }

  subscribe(subscription) {
    markActive(this);
    this.subscribe(subscription);
  }

  unsubscribe() {
    return false;
  }

  bindStore(store, transform = (v) => v) {
    markActive(this);
    this.bindStore(store, transform);
  }

  unbindStore() {
    return false;
  }

  get hasSubscribers() {
    return false;
  }

  publish() {}

  runStores(data, fn, thisArg, ...args) {
    return ReflectApply(fn, thisArg, args)
  }
}

function wrapStoreRun(store, data, next, transform = (v) => v) {
  return () => store.run(transform(data), next);
}

const channels = ObjectCreate(null);

function channel(name) {
  let channel;
  const ref = channels[name];
  if (ref) channel = ref.get();
  if (channel) return channel;

  if (typeof name !== 'string' && typeof name !== 'symbol') {
    throw new ERR_INVALID_ARG_TYPE('channel', ['string', 'symbol'], name);
  }

  channel = new Channel(name);
  channel._weak = new WeakReference(channel);
  channels[name] = channel._weak;
  return channel;
}

function subscribe(name, subscription) {
  return channel(name).subscribe(subscription);
}

function unsubscribe(name, subscription) {
  return channel(name).unsubscribe(subscription);
}

function hasSubscribers(name) {
  let channel;
  const ref = channels[name];
  if (ref) channel = ref.get();
  if (!channel) {
    return false;
  }

  return channel.hasSubscribers;
}

function traceSync(channels, fn, ctx, thisArg, ...args) {
  const { start, end, error } = channels;

  try {
    const result = start.runStores(ctx, fn, thisArg, ...args);
    ctx.result = result;
    return result;
  } catch (err) {
    ctx.error = err;
    error.publish(ctx);
    throw err;
  } finally {
    end.publish(ctx);
  }
}

function traceCallback(channels, fn, position, ctx, thisArg, ...args) {
  const { start, end, asyncEnd, error } = channels;

  function wrap (fn) {
    return function wrappedCallback (err, res) {
      if (err) {
        ctx.error = err;
        error.publish(ctx);
      } else {
        ctx.result = res;
      }

      asyncEnd.publish(ctx);
      if (fn) {
        return ReflectApply(fn, this, arguments);
      }
    }
  }

  if (position >= 0) {
    args.splice(position, 1, wrap(args.at(position)));
  }

  try {
    return start.runStores(ctx, fn, thisArg, ...args);
  } catch (err) {
    ctx.error = err;
    error.publish(ctx);
    throw err;
  } finally {
    end.publish(ctx);
  }
}

function tracePromise(channels, fn, ctx, thisArg, ...args) {
  const { asyncEnd, start, end, error } = channels;

  function reject(err) {
    ctx.error = err;
    error.publish(ctx);
    asyncEnd.publish(ctx);
    return Promise.reject(err);
  }

  function resolve(result) {
    ctx.result = result;
    asyncEnd.publish(ctx);
    return result;
  }

  try {
    const promise = start.runStores(ctx, fn, thisArg, ...args);
    return PromisePrototypeThen(promise, resolve, reject);
  } catch (err) {
    ctx.error = err;
    error.publish(ctx);
    throw err;
  } finally {
    end.publish(ctx);
  }
}

class TracingChannel {
  constructor(name) {
    this.name = name;
    this.channels = {
      start: new Channel(`tracing:${name}:start`),
      end: new Channel(`tracing:${name}:end`),
      asyncEnd: new Channel(`tracing:${name}:asyncEnd`),
      error: new Channel(`tracing:${name}:error`)
    };
  }

  // Attach WeakReference to all the sub-channels so the liveness management
  // in subscribe/unsubscribe keeps the TracingChannel the sub-channels are
  // attached to alive.
  set _weak(weak) {
    for (const key in this.channels) {
      this.channels[key]._weak = weak;
    }
  }

  get hasSubscribers() {
    for (const key in this.channels) {
      if (this.channels[key].hasSubscribers) {
        return true;
      }
    }
    return false;
  }

  subscribe(handlers) {
    for (const key in handlers) {
      this.channels[key]?.subscribe(handlers[key]);
    }
  }

  unsubscribe(handlers) {
    let done = true;
    for (const key in handlers) {
      const channel = this.channels[key];
      if (channel instanceof Channel && !channel.unsubscribe(handlers[key])) {
        done = false;
      }
    }
    return done;
  }

  traceSync(fn, ctx = {}, thisArg, ...args) {
    if (!this.hasSubscribers) return ReflectApply(fn, thisArg, args);
    return traceSync(this.channels, fn, ctx, thisArg, ...args);
  }

  tracePromise(fn, ctx = {}, thisArg, ...args) {
    if (!this.hasSubscribers) return ReflectApply(fn, thisArg, args);
    return tracePromise(this.channels, fn, ctx, thisArg, ...args);
  }

  traceCallback(fn, position = 0, ctx = {}, thisArg, ...args) {
    if (!this.hasSubscribers) return ReflectApply(fn, thisArg, args);
    return traceCallback(this.channels, fn, position, ctx, thisArg, ...args);
  }
}

const tracingChannels = ObjectCreate(null);

function tracingChannel(name) {
  let channel;
  const ref = tracingChannels[name];
  if (ref) channel = ref.get();
  if (channel) return channel;

  if (typeof name !== 'string' && typeof name !== 'symbol') {
    throw new ERR_INVALID_ARG_TYPE('tracingChannel', ['string', 'symbol'], name);
  }

  channel = new TracingChannel(name);
  channel._weak = new WeakReference(channel);
  tracingChannels[name] = channel._weak;
  return channel;
}

module.exports = {
  channel,
  hasSubscribers,
  subscribe,
  tracingChannel,
  traceSync,
  traceCallback,
  tracePromise,
  unsubscribe,
  Channel
};
