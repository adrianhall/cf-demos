/**
 * @file Pure delivery rules: conversion eligibility, the management tier for project edits,
 *   archived-project immutability, task completion stamps, sparse positions, and new-date checks.
 */

import { describe, expect, it } from 'vitest';
import {
  appendPosition,
  archivedEditRefused,
  completionStamp,
  conversionBlocker,
  isAcceptableNewDate,
  needsManage,
  POSITION_GAP
} from '../../../src/data-worker/domain/projects/delivery.ts';

describe('conversionBlocker', () => {
  it('allows only a won, unconverted deal', () => {
    expect(conversionBlocker({ status: 'won', projectId: null })).toBeNull();
    expect(conversionBlocker({ status: 'pending', projectId: null })).toMatch(/won deal/u);
    expect(conversionBlocker({ status: 'lost', projectId: null })).toMatch(/won deal/u);
    expect(conversionBlocker({ status: 'won', projectId: 'p' })).toMatch(/already been converted/u);
  });

  it('with markWon, also allows a pending deal but never a lost or converted one', () => {
    expect(conversionBlocker({ status: 'pending', projectId: null }, true)).toBeNull();
    expect(conversionBlocker({ status: 'won', projectId: null }, true)).toBeNull();
    expect(conversionBlocker({ status: 'lost', projectId: null }, true)).toMatch(/lost deal/u);
    expect(conversionBlocker({ status: 'pending', projectId: 'p' }, true)).toMatch(/already/u);
  });
});

describe('needsManage', () => {
  const before = { status: 'active' as const, leadId: 'a' };

  it('requires manage to archive, unarchive, or change the lead', () => {
    expect(needsManage(before, { status: 'archived' })).toBe(true);
    expect(needsManage({ ...before, status: 'archived' }, { status: 'active' })).toBe(true);
    expect(needsManage(before, { leadId: 'b' })).toBe(true);
  });

  it('treats other status changes and unchanged values as ordinary writes', () => {
    expect(needsManage(before, { status: 'on_hold' })).toBe(false);
    expect(needsManage(before, { status: 'completed' })).toBe(false);
    expect(needsManage(before, { status: 'active', leadId: 'a' })).toBe(false);
    expect(needsManage(before, {})).toBe(false);
  });
});

describe('archivedEditRefused', () => {
  it('permits only unarchiving an archived project', () => {
    expect(archivedEditRefused('archived', undefined)).toBe(true);
    expect(archivedEditRefused('archived', 'archived')).toBe(true);
    expect(archivedEditRefused('archived', 'active')).toBe(false);
    expect(archivedEditRefused('active', undefined)).toBe(false);
  });
});

describe('completionStamp', () => {
  it('stamps on entering done, keeps it while done, and clears it on leaving', () => {
    const open = { status: 'todo' as const, completedAt: null };
    expect(completionStamp(open, 'done', 'now')).toBe('now');
    expect(completionStamp({ status: 'done', completedAt: 'then' }, 'done', 'now')).toBe('then');
    expect(completionStamp({ status: 'done', completedAt: 'then' }, 'in_review', 'now')).toBeNull();
    expect(completionStamp(open, 'in_progress', 'now')).toBeNull();
  });
});

describe('positions and dates', () => {
  it('appends with a sparse gap', () => {
    expect(appendPosition(null)).toBe(0);
    expect(appendPosition(0)).toBe(POSITION_GAP);
    expect(appendPosition(5000)).toBe(5000 + POSITION_GAP);
  });

  it('accepts no date, today, or later for a newly entered date', () => {
    expect(isAcceptableNewDate(null, '2026-10-11')).toBe(true);
    expect(isAcceptableNewDate('2026-10-11', '2026-10-11')).toBe(true);
    expect(isAcceptableNewDate('2026-10-10', '2026-10-11')).toBe(false);
  });
});
