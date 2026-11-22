// The few `assert` calls inside Babel's module transform. CommonJS on purpose: Babel calls the
// module itself as a function (`require("assert")(cond)`), which an ES module namespace can't be.
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
assert.ok = assert;
assert.equal = (a, b, msg) => assert(a == b, msg); // eslint-disable-line eqeqeq
assert.strictEqual = (a, b, msg) => assert(a === b, msg);
assert.notStrictEqual = (a, b, msg) => assert(a !== b, msg);
module.exports = assert;
