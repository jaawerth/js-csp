var assert = require("chai").assert;
var mocha = require("mocha");
var a = require("../src/csp.test-helpers"),
    it = a.it,
    before = a.before,
    beforeEach = a.beforeEach;

var csp = require("../src/csp"),
    chan = csp.chan,
    go = csp.go,
    put = csp.put,
    take = csp.take,
    putAsync = csp.putAsync,
    takeAsync = csp.takeAsync,
    offer = csp.offer,
    poll = csp.poll,
    alts = csp.alts,
    timeout = csp.timeout,
    CLOSED = csp.CLOSED,
    NO_VALUE = csp.NO_VALUE;

var do_alts = require("../src/impl/select").do_alts;

function closed(chanCons) {
  var ch = chanCons();
  ch.close();
  return ch;
}

describe("put", function() {
  describe("that is immediate", function() {
    it("should return true if value is taken", function*() {
      var ch = chan();
      go(function*() {
        yield take(ch);
      });
      assert.equal((yield put(ch, 42)), true);
    });

    it("should return true if value is buffered", function*() {
      var ch = chan(1);
      assert.equal((yield put(ch, 42)), true);
    });

    it("should return false if channel is already closed", function*() {
      var ch = closed(chan);
      assert.equal((yield put(ch, 42)), false);
    });
  });

  describe("that is parked", function() {
    it("should return true if value is then taken", function*() {
      var ch = chan();
      go(function*() {
        yield timeout(5);
        yield take(ch);
      });
      assert.equal((yield put(ch, 42)), true);
    });

    // it("should return true if value is then buffered", function*() {
    //   var ch = chan(1);
    //   var buffered = false;

    //   go(function*() {
    //     yield put(ch, 42);
    //   });
    //   go(function*() {
    //     assert.equal((yield put(ch, 43)), true);
    //     buffered = true;
    //   });

    //   yield take(ch);

    //   // So that the code after the 43-put has the chance to run
    //   yield 1;

    //   assert.equal(buffered, true, "pending put is buffered once the buffer is not full again");
    // });

    it("should return false if channel is then closed", function*() {
      var ch = chan();

      go(function*() {
        yield timeout(5);
        ch.close();

        // XXX FIX: Throwing an exception here (in a "non-top-level"
        // goroutine) makes the alts test crash with a weird "Cannot
        // call method '_take' of undefined". It goes away if
        // Process.prototype.run handles exceptions throw by the
        // generator. It looks like it has to do with mocha's "done"
        // needs to be called for async test to be cleanedly cleaned
        // up. Yikes! Another way to handle it is to catch the
        // exception and call "done" in the test helpers. Actually no,
        // it makes the next tests incorrect. The problem is exception
        // from "non-top-level" goroutines not being handled. Not sure
        // how to fix yet. throw new Error("Ha ha");
      });

      assert.equal((yield put(ch, 42)), false);
    });

    // http://onbeyondlambda.blogspot.com/2014/04/asynchronous-naivete.html
    mocha.it("should be moved to the buffer when a value is taken from it", function(done) {
      var ch = chan(1);
      var count = 0;

      function inc() {
        count ++;
      }

      putAsync(ch, 42, inc);
      putAsync(ch, 42, inc);
      takeAsync(ch, function() {
        go(function*() {
          yield null;
          a.check(function() {
            assert.equal(count, 2);
          }, done);
        });
      });
    });
  });
});

describe("take", function() {
  describe("that is immediate", function() {
    it("should return correct value that was directly put", function*() {
      var ch = chan();
      go(function*() {
        yield put(ch, 42);
      });
      assert.equal((yield take(ch)), 42);
    });

    it("should return correct value that was buffered", function*() {
      var ch = chan(1);
      yield put(ch, 42);
      assert.equal((yield take(ch)), 42);
    });

    it("should return false if channel is already closed", function*() {
      var ch = closed(chan);
      assert.equal((yield take(ch)), CLOSED);
    });
  });

  describe("that is parked", function() {
    it("should return correct value if it is then delivered", function*() {
      var ch = chan();
      go(function*() {
        yield timeout(5);
        yield put(ch, 42);
      });
      assert.equal((yield take(ch)), 42);
    });

    it("should return CLOSED if channel is then closed", function*() {
      var ch = chan();

      go(function*() {
        yield timeout(5);
        ch.close();
      });

      assert.equal((yield take(ch)), CLOSED);
    });
  });
});

describe("offer and poll", function() {
  function noOp() {};

  mocha.it("should succeed if they can be completed immediately by a buffer", function() {
    var ch = chan(2);
    assert.equal(offer(ch, 42), true);
    assert.equal(offer(ch, 43), true);
    assert.equal(offer(ch, 44), false);
    assert.equal(poll(ch), 42);
    assert.equal(poll(ch), 43);
    assert.equal(poll(ch), NO_VALUE);
  });

  mocha.it("should succeed if they can be completed immediately by a pending operation", function() {
    var putCh = chan();
    putAsync(putCh, 42);
    assert.equal(poll(putCh), 42);

    var takeCh = chan();
    takeAsync(takeCh, noOp);
    assert.equal(offer(takeCh, 42), true);
  });

  mocha.it("should fail if they can't complete immediately", function() {
    var ch = chan();
    assert.equal(poll(ch), NO_VALUE);
    assert.equal(offer(ch, 44), false);
  });

  mocha.it("should fail if they are performed on a closed channel", function() {
    var ch = chan();
    ch.close();
    assert.equal(poll(ch), NO_VALUE);
    assert.equal(offer(ch, 44), false);
  });

  mocha.it("should fail if there are pending same-direction operations on a channel", function() {
    var putCh = chan();
    putAsync(putCh, 42);
    assert.equal(offer(putCh, 44), false);

    var takeCh = chan();
    takeAsync(takeCh, noOp);
    assert.equal(poll(takeCh), NO_VALUE);
  });
});

describe("alts", function() {
  function takeReadyFromPut(v) {
    var ch = chan();
    putAsync(ch, v);
    return ch;
  }

  function takeReadyFromBuf(v) {
    var ch = chan(1);
    putAsync(ch, v);
    return ch;
  }

  function noOp() {}

  function putReadyByTake() {
    var ch = chan();
    takeAsync(ch, noOp);
    return ch;
  }

  function putReadyByBuf() {
    var ch = chan(1);
    return ch;
  }

  // To help with testing once-only (i.e. commit logic is correct).
  function once(desc, f, ops) {
    it("should commit correctly after " + desc, function*() {
      var count = 0;
      function inc() {
        count ++;
      }

      var l = ops.length;
      var chs = new Array(l);
      for (var i = 0; i < l; i ++) {
        var op = ops[i];
        if (op instanceof Array) {
          chs[i] = op[0];
        } else {
          chs[i] = op;
        }
      }

      // We want to test that an immediately-available-due-to-closed
      // operation deactivates previously registered operations.
      // Therefore we use "priority" to make sure an already-ready
      // operation that comes last does not short-circuit do_alts.
      do_alts(ops, inc, {priority: true});

      yield* f.apply(this, chs);
      // One more turn for async operations scheduled by f above.
      yield null;

      assert.equal(count, 1);
    });
  }

  it("should work with identity channel", function*() {
    var ch = a.identity_chan(42);
    var r = yield alts([ch]);
    assert.equal(r.value, 42);
    assert.equal(r.channel, ch);
  });

  describe("implementation", function() {
    describe("should not be bugged by js' mutable closure", function() {
      it("when taking", function*() {
        var ch1 = chan();
        var ch2 = chan();

        var ch = go(function*() {
          // FIX: Make it reliable against assertions in spawned
          // goroutines (requiring a finalized error handling strategy).
          return (yield alts([ch1, ch2], {priority: true}));
        });

        go(function*() {
          yield put(ch1, 1);
        });

        var r = yield take(ch);
        assert.equal(r.channel, ch1);
        assert.equal(r.value, 1);
      });

      it("when putting", function*() {
        var ch1 = chan();
        var ch2 = chan();

        var ch = go(function*() {
          return (yield alts([[ch1, 1], [ch2, 1]], {priority: true}));
        });

        go(function*() {
          yield take(ch1);
        });

        var r = yield take(ch);
        assert.equal(r.channel, ch1);
        assert.equal(r.value, true);
      });
    });
  });

  describe("default value", function() {
    var ch;

    before(function*() {
      ch = chan(1);
    });

    it("should be returned if no result is immediately available", function*() {
      var r = yield alts([ch], {default: "none"});
      assert.equal(r.value, "none");
      assert.equal(r.channel, csp.DEFAULT);
    });

    it("should be ignored if some result is immediately available", function*() {
      yield put(ch, 1);
      var r = yield alts([ch], {default: "none"});
      assert.equal(r.value, 1);
      assert.equal(r.channel, ch);
    });
  });

  // FIX: These tests are bad (having (small) chances to pass/fail
  // incorrectly)
  describe("ordering", function() {
    return;
    var n = 100;
    var chs = new Array(n);
    var sequential = new Array(n);

    before(function*() {
      for (var i = 0; i < n; i++) {
        sequential[i] = i;
      }
    });

    beforeEach(function*() {
      for (var i = 0; i < n; i++) {
        var ch = chan(1);
        chs[i] = ch;
        yield put(chs[i], i);
      }
    });

    it("should be non-deterministic by default", function*() {
      var results = new Array(n);
      for (var i = 0; i < n; i++) {
        results[i] = (yield alts(chs)).value;
      }
      assert.notDeepEqual(sequential, results, "alts ordering is randomized");
    });

    it("should follow priority if requested", function*() {
      var results = new Array(n);
      for (var i = 0; i < n; i++) {
        results[i] = (yield alts(chs, {priority: true})).value;
      }
      assert.deepEqual(sequential, results, "alts ordering is fixed if priority option is specified");
    });
  });

  describe("synchronization (at most once guarantee)", function() {
    once("taking from a queued put", function*(ch1, ch2) {
      putAsync(ch1, 2);
    }, [chan(), takeReadyFromPut(1)]);

    once("taking from the buffer", function*(ch1, ch2) {
      putAsync(ch1, 2);
    }, [chan(), takeReadyFromBuf(1)]);

    once("taking from a closed channel", function*(ch1, ch2) {
      putAsync(ch1, 2);
    }, [chan(), closed(chan)]);

    once("putting to a queued take", function*(ch1, ch2) {
      takeAsync(ch1, noOp);
    }, [[chan(), 1], [putReadyByTake(), 2]]);

    once("putting to the buffer", function*(ch1, ch2) {
      takeAsync(ch1, noOp);
    }, [[chan(), 1], [putReadyByBuf(), 2]]);

    once("putting to a closed channel", function*(ch1, ch2) {
      takeAsync(ch1, noOp);
    }, [[chan(), 1], [closed(chan), 2]]);
  });
});

describe("Goroutine", function() {
  it("should put returned value on output channel and close it", function*() {
    var ch = go(function*(x) {
      return x;
    }, [42]);
    var value = yield take(ch);
    assert.equal(value, 42, "returned value is delivered");
    assert.equal(ch.is_closed(), true, "output channel is closed");
  });

  it("should leave yielded normal values untouched", function*() {
    var lst = [42, [42], {x: 42}, "", null, undefined, true, false,
               function() {}, function*() {}];
    var length = lst.length;
    for (var i = 0; i < length; i++) {
      assert.equal((yield lst[i]), lst[i]);
    }
  });

  it("should work when special value CLOSED is returned", function*() {
    var ch = go(function*(x) {
      return x;
    }, [CLOSED]);
    var value = yield take(ch);
    assert.equal(value, CLOSED, "CLOSED is delivered");
    assert.equal(ch.is_closed(), true, "output channel is closed");
  });
});

describe("Process runner", function() {
  // TODO: See if this is sufficiently large for all the runtimes (js
  // can't query stack depth)
  var LIMIT = 25000;
  var ch = closed(chan);

  it("should not blow the stack on repeated takes from a closed channel", function*() {
    for (var i = 0; i < LIMIT; i++) {
      yield take(ch);
    }
  });

  it("should not blow the stack on repeated puts on a closed channel", function*() {
    for (var i = 0; i < LIMIT; i++) {
      yield put(ch, 1);
    }
  });

  it("should not blow the stack on repeated selects on a closed channel", function*() {
    for (var i = 0; i < LIMIT; i++) {
      yield alts([ch, [ch, 1]]);
    }
  });

  it("should not blow the stack on repeated puts and takes that are immediate", function*() {
    var ch = chan(1);
    for (var i = 0; i < LIMIT; i++) {
      yield put(ch, 1);
      yield take(ch);
    }
  });
});

describe("close", function() {
  it("should correctly flush false to pending puts", function*() {
    var ch = chan();
    var count = 0;

    go(function*() {
      assert.equal((yield put(ch, 1)), false);
      count += 1;
      assert.equal(count, 1);
    });
    go(function*() {
      assert.equal((yield put(ch, 2)), false);
      count += 1;
      assert.equal(count, 2);
    });
    go(function*() {
      assert.equal((yield put(ch, 3)), false);
      count += 1;
      assert.equal(count, 3);
    });

    ch.close();
    yield undefined;
  });

  it("should correctly flush CLOSED to pending takes", function*() {
    var ch = chan();
    var count = 0;

    go(function*() {
      assert.equal((yield take(ch)), CLOSED);
      count += 1;
      assert.equal(count, 1);
    });
    go(function*() {
      assert.equal((yield take(ch)), CLOSED);
      count += 1;
      assert.equal(count, 2);
    });
    go(function*() {
      assert.equal((yield take(ch)), CLOSED);
      count += 1;
      assert.equal(count, 3);
    });
    go(function*() {
      assert.ok(csp.isClosedToken(yield take(ch)));
    });

    ch.close();
    yield undefined;
  });
});
