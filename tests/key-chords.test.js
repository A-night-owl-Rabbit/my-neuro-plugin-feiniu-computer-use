'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyChord } = require('../lib/key-chords.js');

test('normalizes aliases and modifier order', () => {
    const chord = classifyChord('Shift+Control+S');
    assert.equal(chord.ok, true);
    assert.equal(chord.canonical, 'ctrl+shift+s');
    assert.equal(classifyChord('Return').canonical, 'enter');
    assert.equal(classifyChord('Escape').canonical, 'esc');
    assert.equal(classifyChord('ArrowDown').canonical, 'down');
    assert.equal(classifyChord('ctrl++').canonical, 'ctrl+=');
});

test('every Windows-key spelling is a hard deny', () => {
    for (const chord of ['win', 'win+d', 'Win+R', 'lwin+e', 'meta+tab', 'super+l', 'cmd+space', 'windows+shift+s', 'ctrl+win+left']) {
        const result = classifyChord(chord);
        assert.equal(result.ok, false, chord);
        assert.equal(result.denied, true, chord);
    }
});

test('system chords are denied, close chords are flagged', () => {
    assert.equal(classifyChord('ctrl+alt+delete').denied, true);
    assert.equal(classifyChord('ctrl+shift+esc').denied, true);
    assert.equal(classifyChord('alt+f4').closes, true);
    assert.equal(classifyChord('ctrl+w').closes, true);
    assert.equal(classifyChord('ctrl+s').closes, false);
    assert.equal(classifyChord('delete').destructive, true);
    assert.equal(classifyChord('enter').submits, true);
});

test('invalid chords are rejected without being flagged as denied', () => {
    assert.equal(classifyChord('').ok, false);
    assert.equal(classifyChord('ctrl').ok, false);
    assert.equal(classifyChord('hyperspace+x').ok, false);
    assert.equal(classifyChord('nonsensekey').ok, false);
    assert.equal(classifyChord('nonsensekey').denied, false);
});

test('autonomous chords support Windows aliases and task manager while reporting OS limitations', () => {
    const options = { autonomousControl: true };
    for (const key of ['win', 'win+r', 'lwin+e', 'meta+tab', 'rwin', 'windows+shift+s', 'ctrl+win+left', 'ctrl+shift+esc', 'alt+f4']) {
        assert.equal(classifyChord(key, options).ok, true, key);
    }
    assert.equal(classifyChord('windows+shift+s', options).canonical, 'shift+win+s');
    assert.equal(classifyChord('ctrl+alt+del', options).denied, false);
    assert.match(classifyChord('ctrl+alt+del', options).reason, /无法通过 SendInput/);
    assert.equal(classifyChord('nonsensekey', options).ok, false);
});
