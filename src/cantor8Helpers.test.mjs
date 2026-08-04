import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidCantor8Transfer,
  describeCantor8Error,
  CANTOR8_DAPP_NAME,
} from './cantor8Helpers.js';

test('CANTOR8_DAPP_NAME matches registered demo name', () => {
  assert.equal(CANTOR8_DAPP_NAME, 'Cantor8 Wallet Connect SDK Demo');
});

test('assertValidCantor8Transfer accepts positive amounts and trims party', () => {
  assert.equal(assertValidCantor8Transfer('  Party::Recv  ', '1.25'), 1.25);
});

test('assertValidCantor8Transfer rejects empty receiver', () => {
  assert.throws(() => assertValidCantor8Transfer('  ', '1'), /receiver/i);
});

test('assertValidCantor8Transfer rejects non-positive amount', () => {
  assert.throws(() => assertValidCantor8Transfer('Party::X', '0'), /amount/i);
  assert.throws(() => assertValidCantor8Transfer('Party::X', '-1'), /amount/i);
  assert.throws(() => assertValidCantor8Transfer('Party::X', 'abc'), /amount/i);
});

test('describeCantor8Error maps known codes', () => {
  assert.match(describeCantor8Error({ code: 'POPUP_BLOCKED', message: 'x' }), /popup/i);
  assert.match(describeCantor8Error({ code: 'USER_REJECTED', message: 'x' }), /dismissed|reject/i);
  assert.match(describeCantor8Error({ code: 'NOT_CONNECTED', message: 'x' }), /connect/i);
  assert.match(describeCantor8Error({ code: 'INSUFFICIENT_FUNDS', message: 'x' }), /balance|funds/i);
  assert.match(describeCantor8Error({ code: 'INIT_FAILED', message: 'x' }), /dappName|network|config/i);
  assert.match(
    describeCantor8Error({ code: 'TRANSFER_PREPARE_FAILED', message: 'x' }),
    /invalid|ledger|transfer/i,
  );
  assert.match(describeCantor8Error({ code: 'TRANSFER_FAILED', message: 'x' }), /invalid|ledger|transfer/i);
  assert.match(describeCantor8Error({ code: 'GET_INSTRUMENTS_FAILED', message: 'x' }), /instrument/i);
  assert.match(describeCantor8Error({ code: 'GET_ACCOUNTS_FAILED', message: 'x' }), /account/i);
  assert.match(describeCantor8Error({ code: 'CHECK_TX_STATUS_FAILED', message: 'x' }), /status/i);
});

test('describeCantor8Error falls back for unknown / Error / string', () => {
  assert.match(describeCantor8Error({ code: 'WEIRD', message: 'boom' }), /WEIRD/);
  assert.match(describeCantor8Error({ code: 'WEIRD', message: 'boom' }), /boom/);
  assert.equal(describeCantor8Error(new Error('plain')), 'plain');
  assert.equal(describeCantor8Error('raw'), 'raw');
});
