'use strict';
// [SECURITY_CHECKLIST #58] The supply-cap proposal reads the program's own
// constants (no drift) and encodes set_supply_cap exactly as the IDL says.
const test = require('node:test');
const assert = require('node:assert/strict');
const model = () => import('../../scripts/economy/propose-caps.mjs');

test('emission model reads the program constants and sizes every cap', async () => {
  const m = await model();
  const c = m.readConstants();
  assert.deepEqual([c.baseRate, c.yieldLegendaryBps, c.villagers, c.seasonDays], [10, 18000, 6, 42]);
  assert.deepEqual(c.well, [0, 5, 15, 20]);
  const d = m.dailyPerPlayer(c, 100);
  for (const k of [1, 2, 3, 9]) assert.equal(d[k], 648, `mining kind ${k}`);
  assert.equal(d[7], 216, 'Power: 24 h at the fair ~9/h');
  assert.equal(d[4], 972, 'Synapse = 1.5 x Neuron');
  assert.equal(m.seasonRewardPerPlayer(c), 180600, 'every level on both tracks');
  const caps = m.proposeCaps({ c, dau: 1000, days: 42, safety: 1.5, otherDaily: 100 });
  assert.equal(caps.length, 27);
  assert.equal(caps[1].capUnits, 311724000, '(648*1000*42 + 180600*1000) * 1.5');
  assert.equal(caps[7].capUnits, 13608000);
  assert.ok(caps.every((x) => x.capAtomic > 0n && x.capAtomic <= 0xffffffffffffffffn));
  const withSupply = m.proposeCaps({ c, dau: 1000, days: 42, safety: 1.5, otherDaily: 100, supply: Array(27).fill(5n) });
  assert.equal(withSupply[0].capAtomic, caps[0].capAtomic + 5n, 'existing supply is kept on top');
  assert.throws(() => m.proposeCaps({ c, dau: 0, days: 42, safety: 1.5, otherDaily: 100 }));
});

test('set_supply_cap is encoded from the committed IDL', async () => {
  const m = await model();
  const enc = m.encodeSetSupplyCap(7, 123456789n);
  assert.deepEqual([...enc.data.subarray(0, 8)], [26, 229, 174, 213, 12, 59, 220, 71]);
  assert.equal(enc.data[8], 7);
  assert.equal(enc.data.readBigUInt64LE(9), 123456789n);
  assert.deepEqual(enc.accounts.map((a) => a.name), ['config', 'authority', 'material_mints']);
  assert.equal(m.base58(Buffer.from('Hello World')), 'JxF12TrwUP45BMd');
  assert.equal(m.base58(Buffer.from([0, 0, 1])), '112');
});
