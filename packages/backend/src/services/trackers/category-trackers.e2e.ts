import { TRACKER_TYPES, TRANSACTION_TYPES } from '@bt/shared/types';
import { NONEXISTENT_ID } from '@common/lib/record-id-helpers';
import { describe, expect, it } from '@jest/globals';
import { ERROR_CODES } from '@js/errors';
import * as helpers from '@tests/helpers';

import { getResponseInitialState } from './stats';

/**
 * E2E tests for Category-Based Trackers
 *
 * These tests verify the complete flow of category-based trackers including:
 * - Creation with categories
 * - Editing and category assignment/unassignment
 * - Stats calculation based on transaction categories
 * - Split transaction handling
 * - Edge cases
 */
describe('Category-Based Trackers', () => {
  describe('Tracker Creation', () => {
    it('successfully creates a category tracker with single category', async () => {
      // Create a category
      const category = await helpers.addCustomCategory({
        name: 'Food',
        color: '#FF0000',
        raw: true,
      });

      // Create category tracker
      const tracker = await helpers.createTracker({
        name: 'Food Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        limitAmount: 500,
        raw: true,
      });

      expect(tracker.type).toBe(TRACKER_TYPES.category);
      expect(tracker.categories).toHaveLength(1);
      expect(tracker.categories![0]!.id).toBe(category.id);
      expect(tracker.limitAmount).toBe(500);
    });

    it('successfully creates a category tracker with multiple categories', async () => {
      const category1 = await helpers.addCustomCategory({
        name: 'Restaurants',
        color: '#FF0000',
        raw: true,
      });
      const category2 = await helpers.addCustomCategory({
        name: 'Cafes',
        color: '#00FF00',
        raw: true,
      });
      const category3 = await helpers.addCustomCategory({
        name: 'Bars',
        color: '#0000FF',
        raw: true,
      });

      const tracker = await helpers.createTracker({
        name: 'Eating Out Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category1.id, category2.id, category3.id],
        limitAmount: 1000,
        raw: true,
      });

      expect(tracker.type).toBe(TRACKER_TYPES.category);
      expect(tracker.categories).toHaveLength(3);
      const categoryIds = tracker.categories.map((c) => c.id);
      expect(categoryIds).toContain(category1.id);
      expect(categoryIds).toContain(category2.id);
      expect(categoryIds).toContain(category3.id);
    });

    it('successfully creates a category tracker with parent category (auto-includes children)', async () => {
      // Create parent category
      const parentCategory = await helpers.addCustomCategory({
        name: 'Entertainment',
        color: '#FF0000',
        raw: true,
      });

      // Create child categories
      const child1 = await helpers.addCustomCategory({
        name: 'Movies',
        color: '#00FF00',
        parentId: parentCategory.id,
        raw: true,
      });
      const child2 = await helpers.addCustomCategory({
        name: 'Games',
        color: '#0000FF',
        parentId: parentCategory.id,
        raw: true,
      });

      // Create tracker with parent only - children should be auto-included
      const tracker = await helpers.createTracker({
        name: 'Entertainment Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [parentCategory.id],
        raw: true,
      });

      expect(tracker.type).toBe(TRACKER_TYPES.category);
      // Should have parent + 2 children
      expect(tracker.categories).toHaveLength(3);
      const categoryIds = tracker.categories.map((c) => c.id);
      expect(categoryIds).toContain(parentCategory.id);
      expect(categoryIds).toContain(child1.id);
      expect(categoryIds).toContain(child2.id);
    });

    it('fails to create a category tracker with an empty or unknown category list', async () => {
      const withoutCategories = await helpers.createTracker({
        name: 'Invalid Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [],
        raw: false,
      });

      expect(withoutCategories.statusCode).toBe(ERROR_CODES.ValidationError);

      const withUnknownCategory = await helpers.createTracker({
        name: 'Invalid Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [NONEXISTENT_ID],
        raw: false,
      });

      expect(withUnknownCategory.statusCode).toBe(ERROR_CODES.ValidationError);
    });

    it('creates a manual tracker with the type omitted or passed explicitly', async () => {
      const defaultTypeTracker = await helpers.createTracker({
        name: 'Manual Tracker',
        limitAmount: 1000,
        raw: true,
      });

      expect(defaultTypeTracker.type).toBe(TRACKER_TYPES.manual);
      expect(defaultTypeTracker.categories).toHaveLength(0);

      const explicitTypeTracker = await helpers.createTracker({
        name: 'Manual Tracker Explicit',
        type: TRACKER_TYPES.manual,
        limitAmount: 1000,
        raw: true,
      });

      expect(explicitTypeTracker.type).toBe(TRACKER_TYPES.manual);
      expect(explicitTypeTracker.categories).toHaveLength(0);
    }, 60_000);
  });

  describe('Tracker Editing', () => {
    it('successfully updates category tracker categories', async () => {
      const category1 = await helpers.addCustomCategory({ name: 'Cat1', color: '#FF0000', raw: true });
      const category2 = await helpers.addCustomCategory({ name: 'Cat2', color: '#00FF00', raw: true });

      // Create tracker with one category
      const tracker = await helpers.createTracker({
        name: 'Test Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category1.id],
        raw: true,
      });

      expect(tracker.categories).toHaveLength(1);

      // Update to include both categories
      const updatedTracker = await helpers.editTracker({
        id: tracker.id,
        params: { categoryIds: [category1.id, category2.id] },
        raw: true,
      });

      expect(updatedTracker.categories).toHaveLength(2);
    });

    it('successfully removes categories from tracker', async () => {
      const category1 = await helpers.addCustomCategory({ name: 'Cat1', color: '#FF0000', raw: true });
      const category2 = await helpers.addCustomCategory({ name: 'Cat2', color: '#00FF00', raw: true });

      const tracker = await helpers.createTracker({
        name: 'Test Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category1.id, category2.id],
        raw: true,
      });

      expect(tracker.categories).toHaveLength(2);

      // Remove one category
      const updatedTracker = await helpers.editTracker({
        id: tracker.id,
        params: { categoryIds: [category1.id] },
        raw: true,
      });

      expect(updatedTracker.categories).toHaveLength(1);
      expect(updatedTracker.categories![0]!.id).toBe(category1.id);
    });

    it('successfully updates tracker name without affecting categories', async () => {
      const category = await helpers.addCustomCategory({ name: 'Cat1', color: '#FF0000', raw: true });

      const tracker = await helpers.createTracker({
        name: 'Original Name',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        raw: true,
      });

      const updatedTracker = await helpers.editTracker({
        id: tracker.id,
        params: { name: 'New Name' },
        raw: true,
      });

      expect(updatedTracker.name).toBe('New Name');
      expect(updatedTracker.categories).toHaveLength(1);
      expect(updatedTracker.categories![0]!.id).toBe(category.id);
    });

    it('rejects an empty or foreign category list and keeps categories and lines', async () => {
      const category = await helpers.addCustomCategory({ name: 'Cat1', color: '#FF0000', raw: true });
      const tracker = await helpers.createTracker({
        name: 'Test Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        raw: true,
      });
      const line = await helpers.createTrackerLine({
        trackerId: tracker.id,
        payload: { name: 'Line', categoryIds: [category.id] },
        raw: true,
      });
      const stranger = await helpers.provisionSecondUserWithBaseCurrency();
      const foreignCategory = await helpers.asUser({
        cookies: stranger.cookies,
        fn: () => helpers.addCustomCategory({ name: 'Foreign', color: '#00FF00', raw: true }),
      });

      for (const categoryIds of [[], [foreignCategory.id]]) {
        const response = await helpers.editTracker({ id: tracker.id, params: { categoryIds }, raw: false });
        expect(response.statusCode).toBe(ERROR_CODES.ValidationError);
      }

      const fetched = (await helpers.getTrackerById({ id: tracker.id, raw: true }))!;
      expect(fetched.categories!.map((c) => c.id)).toEqual([category.id]);
      expect(fetched.lines!.map((l) => l.id)).toEqual([line.id]);
    });
  });

  describe('Stats Calculation - Basic', () => {
    it('correctly calculates stats for transactions matching category', async () => {
      const category = await helpers.addCustomCategory({ name: 'Groceries', color: '#FF0000', raw: true });

      // Create category tracker
      const tracker = await helpers.createTracker({
        name: 'Grocery Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        limitAmount: 500,
        raw: true,
      });

      // Create expense transaction with matching category
      const account = await helpers.createAccount({ raw: true });
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 100,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category.id,
        }),
        raw: true,
      });

      // Create another expense
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 50,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category.id,
        }),
        raw: true,
      });

      const stats = await helpers.getTrackerStats({ id: tracker.id, raw: true });

      expect(stats!.summary.actualExpense).toBe(150);
      expect(stats!.summary.actualIncome).toBe(0);
      expect(stats!.summary.balance).toBe(-150);
      expect(stats!.summary.utilizationRate).toBeCloseTo((150 / 500) * 100, 1);
      expect(stats!.summary.transactionsCount).toBe(2);
    });

    it('does not count transactions with non-matching categories', async () => {
      const category1 = await helpers.addCustomCategory({ name: 'Groceries', color: '#FF0000', raw: true });
      const category2 = await helpers.addCustomCategory({ name: 'Transport', color: '#00FF00', raw: true });

      // Tracker only tracks category1
      const tracker = await helpers.createTracker({
        name: 'Grocery Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category1.id],
        limitAmount: 500,
        raw: true,
      });

      const account = await helpers.createAccount({ raw: true });

      // Transaction with matching category
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 100,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category1.id,
        }),
        raw: true,
      });

      // Transaction with non-matching category
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 200,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category2.id,
        }),
        raw: true,
      });

      const stats = await helpers.getTrackerStats({ id: tracker.id, raw: true });

      // Should only count the transaction with category1
      expect(stats!.summary.actualExpense).toBe(100);
      expect(stats!.summary.transactionsCount).toBe(1);
    });

    it('counts both income and expense transactions', async () => {
      const category = await helpers.addCustomCategory({ name: 'Freelance', color: '#FF0000', raw: true });

      const tracker = await helpers.createTracker({
        name: 'Freelance Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        raw: true,
      });

      const account = await helpers.createAccount({ raw: true });

      // Income transaction
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 500,
          transactionType: TRANSACTION_TYPES.income,
          categoryId: category.id,
        }),
        raw: true,
      });

      // Expense transaction
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 100,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category.id,
        }),
        raw: true,
      });

      const stats = await helpers.getTrackerStats({ id: tracker.id, raw: true });

      expect(stats!.summary.actualIncome).toBe(500);
      expect(stats!.summary.actualExpense).toBe(100);
      expect(stats!.summary.balance).toBe(400);
      expect(stats!.summary.transactionsCount).toBe(2);
    });

    it('tracks transactions with child categories when parent is in tracker', async () => {
      const parentCategory = await helpers.addCustomCategory({ name: 'Food', color: '#FF0000', raw: true });
      const childCategory = await helpers.addCustomCategory({
        name: 'Restaurants',
        color: '#00FF00',
        parentId: parentCategory.id,
        raw: true,
      });

      // Tracker includes parent (which auto-includes children)
      const tracker = await helpers.createTracker({
        name: 'Food Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [parentCategory.id],
        raw: true,
      });

      const account = await helpers.createAccount({ raw: true });

      // Transaction with child category
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 50,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: childCategory.id,
        }),
        raw: true,
      });

      // Transaction with parent category
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 30,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: parentCategory.id,
        }),
        raw: true,
      });

      const stats = await helpers.getTrackerStats({ id: tracker.id, raw: true });

      // Should count both parent and child category transactions
      expect(stats!.summary.actualExpense).toBe(80);
      expect(stats!.summary.transactionsCount).toBe(2);
    });
  });

  describe('Stats Calculation - Split Transactions', () => {
    it('counts only splits whose category the tracker tracks', async () => {
      const category1 = await helpers.addCustomCategory({ name: 'Food', color: '#FF0000', raw: true });
      const category2 = await helpers.addCustomCategory({ name: 'Transport', color: '#00FF00', raw: true });
      const category3 = await helpers.addCustomCategory({ name: 'Entertainment', color: '#0000FF', raw: true });

      const account = await helpers.createAccount({ raw: true });

      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 150,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category1.id,
          splits: [
            { amount: 50, categoryId: category1.id },
            { amount: 30, categoryId: category2.id },
            { amount: 70, categoryId: category3.id },
          ],
        }),
        raw: true,
      });

      const oneCategoryTracker = await helpers.createTracker({
        name: 'Food Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category1.id],
        limitAmount: 500,
        raw: true,
      });
      const twoCategoryTracker = await helpers.createTracker({
        name: 'Essential Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category1.id, category2.id],
        raw: true,
      });
      const allCategoryTracker = await helpers.createTracker({
        name: 'Everything Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category1.id, category2.id, category3.id],
        raw: true,
      });

      const oneCategoryStats = await helpers.getTrackerStats({
        id: oneCategoryTracker.id,
        raw: true,
      });
      expect(oneCategoryStats!.summary.actualExpense).toBe(50);
      expect(oneCategoryStats!.summary.transactionsCount).toBe(1);

      const twoCategoryStats = await helpers.getTrackerStats({
        id: twoCategoryTracker.id,
        raw: true,
      });
      expect(twoCategoryStats!.summary.actualExpense).toBe(80);
      expect(twoCategoryStats!.summary.transactionsCount).toBe(1);

      const allCategoryStats = await helpers.getTrackerStats({
        id: allCategoryTracker.id,
        raw: true,
      });
      expect(allCategoryStats!.summary.actualExpense).toBe(150);
      expect(allCategoryStats!.summary.transactionsCount).toBe(1);
    }, 60_000);
  });

  describe('Stats Calculation - Date Windows', () => {
    it('applies tracker date windows when calculating stats', async () => {
      const category = await helpers.addCustomCategory({ name: 'Test', color: '#FF0000', raw: true });
      const account = await helpers.createAccount({ raw: true });

      const seedTimes: [number, string][] = [
        [100, '2025-01-15T12:00:00Z'],
        [200, '2025-02-15T12:00:00Z'],
        [300, '2025-03-01T00:00:00Z'],
        [400, '2025-03-15T12:00:00Z'],
        [500, '2025-03-31T23:59:59Z'],
        [600, '2025-04-15T12:00:00Z'],
        [700, '2025-06-15T12:00:00Z'],
      ];

      for (const [amount, time] of seedTimes) {
        await helpers.createTransaction({
          payload: helpers.buildTransactionPayload({
            accountId: account.id,
            amount,
            transactionType: TRANSACTION_TYPES.expense,
            categoryId: category.id,
            time,
          }),
          raw: true,
        });
      }

      const rangeTracker = await helpers.createTracker({
        name: 'March Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        startDate: '2025-03-01T00:00:00Z',
        endDate: '2025-03-31T23:59:59Z',
        raw: true,
      });
      const startOnlyTracker = await helpers.createTracker({
        name: 'Start Only Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        startDate: '2025-03-01T00:00:00Z',
        endDate: null,
        raw: true,
      });
      const endOnlyTracker = await helpers.createTracker({
        name: 'End Only Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        startDate: null,
        endDate: '2025-03-31T23:59:59Z',
        raw: true,
      });
      const openTracker = await helpers.createTracker({
        name: 'Open Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        raw: true,
      });

      // Both boundaries are inclusive: the 2025-03-01T00:00:00Z and 2025-03-31T23:59:59Z rows count.
      const rangeStats = await helpers.getTrackerStats({
        id: rangeTracker.id,
        raw: true,
      });
      expect(rangeStats!.summary.actualExpense).toBe(1200);
      expect(rangeStats!.summary.transactionsCount).toBe(3);

      const startOnlyStats = await helpers.getTrackerStats({
        id: startOnlyTracker.id,
        raw: true,
      });
      expect(startOnlyStats!.summary.actualExpense).toBe(2500);
      expect(startOnlyStats!.summary.transactionsCount).toBe(5);

      const endOnlyStats = await helpers.getTrackerStats({
        id: endOnlyTracker.id,
        raw: true,
      });
      expect(endOnlyStats!.summary.actualExpense).toBe(1500);
      expect(endOnlyStats!.summary.transactionsCount).toBe(5);

      const openStats = await helpers.getTrackerStats({
        id: openTracker.id,
        raw: true,
      });
      expect(openStats!.summary.actualExpense).toBe(2800);
      expect(openStats!.summary.transactionsCount).toBe(7);
    }, 60_000);
  });

  describe('Category Tracker vs Manual Tracker Stats', () => {
    it('manual tracker does not auto-track transactions by category', async () => {
      const category = await helpers.addCustomCategory({ name: 'Test', color: '#FF0000', raw: true });

      // Create manual tracker
      const tracker = await helpers.createTracker({
        name: 'Manual Tracker',
        type: TRACKER_TYPES.manual,
        raw: true,
      });

      const account = await helpers.createAccount({ raw: true });

      // Create transaction with category
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 100,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category.id,
        }),
        raw: true,
      });

      const stats = await helpers.getTrackerStats({ id: tracker.id, raw: true });

      // Manual tracker should NOT auto-count transactions by category
      expect(stats).toEqual(getResponseInitialState());
    });

    it('manual tracker counts manually linked transactions', async () => {
      const category = await helpers.addCustomCategory({ name: 'Test', color: '#FF0000', raw: true });

      // Create manual tracker
      const tracker = await helpers.createTracker({
        name: 'Manual Tracker',
        type: TRACKER_TYPES.manual,
        raw: true,
      });

      const account = await helpers.createAccount({ raw: true });

      // Create transaction
      const [tx] = await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 100,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category.id,
        }),
        raw: true,
      });

      // Manually link transaction to tracker
      await helpers.addTransactionsToTracker({
        id: tracker.id,
        payload: { transactionIds: [tx.id] },
        raw: true,
      });

      const stats = await helpers.getTrackerStats({ id: tracker.id, raw: true });

      // Should now count the manually linked transaction
      expect(stats!.summary.actualExpense).toBe(100);
      expect(stats!.summary.transactionsCount).toBe(1);
    });

    it('category tracker cannot have transactions manually linked', async () => {
      const category = await helpers.addCustomCategory({ name: 'Test', color: '#FF0000', raw: true });

      // Create category tracker
      const tracker = await helpers.createTracker({
        name: 'Category Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        raw: true,
      });

      const account = await helpers.createAccount({ raw: true });

      const [tx] = await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 100,
          transactionType: TRANSACTION_TYPES.expense,
        }),
        raw: true,
      });

      // Try to manually link transaction to category tracker - should fail or be ignored
      const response = await helpers.addTransactionsToTracker({
        id: tracker.id,
        payload: { transactionIds: [tx.id] },
        raw: false,
      });

      // Category trackers should reject manual transaction linking
      expect(response.statusCode).toBe(ERROR_CODES.ValidationError);
    });
  });

  describe('Edge Cases', () => {
    it('returns empty stats for category tracker with no matching transactions', async () => {
      const category = await helpers.addCustomCategory({ name: 'Empty', color: '#FF0000', raw: true });

      const tracker = await helpers.createTracker({
        name: 'Empty Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        raw: true,
      });

      const stats = await helpers.getTrackerStats({ id: tracker.id, raw: true });

      expect(stats).toEqual(getResponseInitialState());
    });

    it('handles category deletion gracefully', async () => {
      const category1 = await helpers.addCustomCategory({ name: 'Cat1', color: '#FF0000', raw: true });
      const category2 = await helpers.addCustomCategory({ name: 'Cat2', color: '#00FF00', raw: true });

      // Create tracker with both categories
      const tracker = await helpers.createTracker({
        name: 'Test Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category1.id, category2.id],
        raw: true,
      });

      expect(tracker.categories).toHaveLength(2);

      // Delete one category
      await helpers.deleteCustomCategory({ categoryId: category1.id, raw: true });

      // Fetch tracker again
      const updatedTracker = await helpers.getTrackerById({ id: tracker.id, raw: true });

      // Should only have one category now
      expect(updatedTracker!.categories).toHaveLength(1);
      expect(updatedTracker!.categories![0]!.id).toBe(category2.id);
    });

    it('handles multiple trackers tracking same category', async () => {
      const category = await helpers.addCustomCategory({ name: 'Shared', color: '#FF0000', raw: true });

      // Create two trackers tracking the same category
      const tracker1 = await helpers.createTracker({
        name: 'Tracker 1',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        limitAmount: 500,
        raw: true,
      });

      const tracker2 = await helpers.createTracker({
        name: 'Tracker 2',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        limitAmount: 1000,
        raw: true,
      });

      const account = await helpers.createAccount({ raw: true });

      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 100,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category.id,
        }),
        raw: true,
      });

      // Both trackers should count the same transaction
      const stats1 = await helpers.getTrackerStats({ id: tracker1.id, raw: true });
      const stats2 = await helpers.getTrackerStats({ id: tracker2.id, raw: true });

      expect(stats1!.summary.actualExpense).toBe(100);
      expect(stats2!.summary.actualExpense).toBe(100);

      // But utilization rates should differ based on limits
      expect(stats1!.summary.utilizationRate).toBeCloseTo((100 / 500) * 100, 1);
      expect(stats2!.summary.utilizationRate).toBeCloseTo((100 / 1000) * 100, 1);
    });

    it('handles overlapping categories in tracker (no double counting)', async () => {
      const parentCategory = await helpers.addCustomCategory({ name: 'Parent', color: '#FF0000', raw: true });
      const childCategory = await helpers.addCustomCategory({
        name: 'Child',
        color: '#00FF00',
        parentId: parentCategory.id,
        raw: true,
      });

      // Tracker explicitly includes both parent and child
      const tracker = await helpers.createTracker({
        name: 'Test Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [parentCategory.id, childCategory.id],
        raw: true,
      });

      const account = await helpers.createAccount({ raw: true });

      // Transaction with child category
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 100,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: childCategory.id,
        }),
        raw: true,
      });

      const stats = await helpers.getTrackerStats({ id: tracker.id, raw: true });

      // Should NOT double-count the transaction
      expect(stats!.summary.actualExpense).toBe(100);
      expect(stats!.summary.transactionsCount).toBe(1);
    });

    it('handles transaction deletion', async () => {
      const category = await helpers.addCustomCategory({ name: 'Test', color: '#FF0000', raw: true });

      const tracker = await helpers.createTracker({
        name: 'Test Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        raw: true,
      });

      const account = await helpers.createAccount({ raw: true });

      const [tx] = await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 100,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category.id,
        }),
        raw: true,
      });

      // Verify transaction is counted
      let stats = await helpers.getTrackerStats({ id: tracker.id, raw: true });
      expect(stats!.summary.actualExpense).toBe(100);

      // Delete transaction
      await helpers.deleteTransaction({ id: tx.id });

      // Verify transaction is no longer counted
      stats = await helpers.getTrackerStats({ id: tracker.id, raw: true });
      expect(stats!.summary.actualExpense).toBe(0);
    });

    it('handles tracker deletion', async () => {
      const category = await helpers.addCustomCategory({ name: 'Test', color: '#FF0000', raw: true });

      const tracker = await helpers.createTracker({
        name: 'To Delete',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        raw: true,
      });

      // Delete tracker
      await helpers.deleteTracker({ id: tracker.id, raw: true });

      // Verify tracker no longer exists
      const response = await helpers.getTrackerById({ id: tracker.id, raw: false });
      expect(response.statusCode).toBe(ERROR_CODES.NotFoundError);
    });
  });

  describe('Listing and Filtering', () => {
    it('returns trackers with categories populated', async () => {
      const category = await helpers.addCustomCategory({ name: 'Test', color: '#FF0000', raw: true });

      await helpers.createTracker({
        name: 'Category Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        raw: true,
      });

      await helpers.createTracker({
        name: 'Manual Tracker',
        type: TRACKER_TYPES.manual,
        raw: true,
      });

      const trackers = await helpers.getTrackers({ raw: true });

      expect(trackers.length).toBe(2);

      const categoryTracker = trackers.find((b) => b.name === 'Category Tracker');
      const manualTracker = trackers.find((b) => b.name === 'Manual Tracker');

      expect(categoryTracker!.type).toBe(TRACKER_TYPES.category);
      expect(categoryTracker!.categories).toHaveLength(1);
      expect(categoryTracker!.categories![0]!.id).toBe(category.id);

      expect(manualTracker!.type).toBe(TRACKER_TYPES.manual);
      expect(manualTracker!.categories).toHaveLength(0);
    });
  });

  describe('Get Category Tracker Transactions Endpoint', () => {
    it('returns transactions matching tracker categories', async () => {
      const category = await helpers.addCustomCategory({ name: 'Food', color: '#FF0000', raw: true });

      const tracker = await helpers.createTracker({
        name: 'Food Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        raw: true,
      });

      const account = await helpers.createAccount({ raw: true });

      // Create matching transaction
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 100,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category.id,
        }),
        raw: true,
      });

      const result = await helpers.getCategoryTrackerTransactions({ id: tracker.id, raw: true });

      expect(result.total).toBe(1);
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0]!.effectiveCategory?.id).toBe(category.id);
      expect(result.transactions[0]!.effectiveCategory?.name).toBe('Food');
    });

    it('excludes transactions not matching tracker categories', async () => {
      const category1 = await helpers.addCustomCategory({ name: 'Food', color: '#FF0000', raw: true });
      const category2 = await helpers.addCustomCategory({ name: 'Transport', color: '#00FF00', raw: true });

      // Tracker only tracks Food
      const tracker = await helpers.createTracker({
        name: 'Food Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category1.id],
        raw: true,
      });

      const account = await helpers.createAccount({ raw: true });

      // Matching transaction
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 100,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category1.id,
        }),
        raw: true,
      });

      // Non-matching transaction
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 200,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category2.id,
        }),
        raw: true,
      });

      const result = await helpers.getCategoryTrackerTransactions({ id: tracker.id, raw: true });

      expect(result.total).toBe(1);
      expect(result.transactions[0]!.effectiveCategory?.id).toBe(category1.id);
    });

    it('returns one entry per matching split', async () => {
      const category1 = await helpers.addCustomCategory({ name: 'Groceries', color: '#FF0000', raw: true });
      const category2 = await helpers.addCustomCategory({ name: 'Household', color: '#00FF00', raw: true });
      const category3 = await helpers.addCustomCategory({
        name: 'Leisure',
        color: '#0000FF',
        raw: true,
      });

      const account = await helpers.createAccount({ raw: true });

      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 150,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category1.id,
          splits: [
            { amount: 50, categoryId: category1.id },
            { amount: 30, categoryId: category2.id },
            { amount: 70, categoryId: category3.id },
          ],
        }),
        raw: true,
      });

      const oneCategoryTracker = await helpers.createTracker({
        name: 'Grocery Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category1.id],
        raw: true,
      });
      const twoCategoryTracker = await helpers.createTracker({
        name: 'Shopping Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category1.id, category2.id],
        raw: true,
      });

      const oneCategoryResult = await helpers.getCategoryTrackerTransactions({
        id: oneCategoryTracker.id,
        raw: true,
      });
      expect(oneCategoryResult.total).toBe(1);
      expect(oneCategoryResult.transactions[0]!.effectiveCategory?.id).toBe(category1.id);
      expect(oneCategoryResult.transactions[0]!.effectiveRefAmount).toBe(50);

      const twoCategoryResult = await helpers.getCategoryTrackerTransactions({
        id: twoCategoryTracker.id,
        raw: true,
      });
      expect(twoCategoryResult.total).toBe(2);
      const amounts = twoCategoryResult.transactions.map((t) => t.effectiveRefAmount);
      expect(amounts).toContain(50);
      expect(amounts).toContain(30);
    }, 60_000);

    it('supports pagination with from and limit', async () => {
      const category = await helpers.addCustomCategory({ name: 'Test', color: '#FF0000', raw: true });

      const tracker = await helpers.createTracker({
        name: 'Test Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        raw: true,
      });

      const account = await helpers.createAccount({ raw: true });

      // Create 5 transactions
      for (let i = 1; i <= 5; i++) {
        await helpers.createTransaction({
          payload: helpers.buildTransactionPayload({
            accountId: account.id,
            amount: i * 10,
            transactionType: TRANSACTION_TYPES.expense,
            categoryId: category.id,
            time: `2025-03-0${i}T12:00:00Z`,
          }),
          raw: true,
        });
      }

      // Get first page
      const page1 = await helpers.getCategoryTrackerTransactions({ id: tracker.id, from: 0, limit: 2, raw: true });
      expect(page1.total).toBe(5);
      expect(page1.transactions).toHaveLength(2);

      // Get second page
      const page2 = await helpers.getCategoryTrackerTransactions({ id: tracker.id, from: 2, limit: 2, raw: true });
      expect(page2.total).toBe(5);
      expect(page2.transactions).toHaveLength(2);

      // Get last page
      const page3 = await helpers.getCategoryTrackerTransactions({ id: tracker.id, from: 4, limit: 2, raw: true });
      expect(page3.total).toBe(5);
      expect(page3.transactions).toHaveLength(1);
    });

    it('returns empty array for tracker with no matching transactions', async () => {
      const category = await helpers.addCustomCategory({ name: 'Empty', color: '#FF0000', raw: true });

      const tracker = await helpers.createTracker({
        name: 'Empty Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        raw: true,
      });

      const result = await helpers.getCategoryTrackerTransactions({ id: tracker.id, raw: true });

      expect(result.total).toBe(0);
      expect(result.transactions).toHaveLength(0);
    });

    it('rejects a manual tracker id and an unknown tracker id', async () => {
      const manualTracker = await helpers.createTracker({
        name: 'Manual Tracker',
        type: TRACKER_TYPES.manual,
        raw: true,
      });

      const manualResponse = await helpers.getCategoryTrackerTransactions({
        id: manualTracker.id,
        raw: false,
      });
      expect(manualResponse.statusCode).toBe(ERROR_CODES.ValidationError);

      const unknownResponse = await helpers.getCategoryTrackerTransactions({
        id: NONEXISTENT_ID,
        raw: false,
      });
      expect(unknownResponse.statusCode).toBe(ERROR_CODES.NotFoundError);
    });

    it('returns transactions sorted by date descending', async () => {
      const category = await helpers.addCustomCategory({ name: 'Test', color: '#FF0000', raw: true });

      const tracker = await helpers.createTracker({
        name: 'Test Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        raw: true,
      });

      const account = await helpers.createAccount({ raw: true });

      // Create transactions in non-chronological order
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 100,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category.id,
          time: '2025-03-01T12:00:00Z',
        }),
        raw: true,
      });

      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 300,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category.id,
          time: '2025-03-15T12:00:00Z',
        }),
        raw: true,
      });

      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 200,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category.id,
          time: '2025-03-10T12:00:00Z',
        }),
        raw: true,
      });

      const result = await helpers.getCategoryTrackerTransactions({ id: tracker.id, raw: true });

      expect(result.transactions).toHaveLength(3);
      // Should be sorted DESC: 300 (Mar 15), 200 (Mar 10), 100 (Mar 1)
      expect(result.transactions[0]!.effectiveRefAmount).toBe(300);
      expect(result.transactions[1]!.effectiveRefAmount).toBe(200);
      expect(result.transactions[2]!.effectiveRefAmount).toBe(100);
    });

    it('applies tracker date windows to the transactions endpoint', async () => {
      const category = await helpers.addCustomCategory({ name: 'Test', color: '#FF0000', raw: true });
      const account = await helpers.createAccount({ raw: true });

      const seedTimes: [number, string][] = [
        [100, '2025-01-15T12:00:00Z'],
        [200, '2025-02-15T12:00:00Z'],
        [300, '2025-03-01T00:00:00Z'],
        [400, '2025-03-15T12:00:00Z'],
        [500, '2025-03-31T23:59:59Z'],
        [600, '2025-04-15T12:00:00Z'],
        [700, '2025-06-15T12:00:00Z'],
      ];

      for (const [amount, time] of seedTimes) {
        await helpers.createTransaction({
          payload: helpers.buildTransactionPayload({
            accountId: account.id,
            amount,
            transactionType: TRANSACTION_TYPES.expense,
            categoryId: category.id,
            time,
          }),
          raw: true,
        });
      }

      const rangeTracker = await helpers.createTracker({
        name: 'March Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        startDate: '2025-03-01T00:00:00Z',
        endDate: '2025-03-31T23:59:59Z',
        raw: true,
      });
      const startOnlyTracker = await helpers.createTracker({
        name: 'Start Only Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        startDate: '2025-03-01T00:00:00Z',
        endDate: null,
        raw: true,
      });
      const endOnlyTracker = await helpers.createTracker({
        name: 'End Only Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        startDate: null,
        endDate: '2025-03-31T23:59:59Z',
        raw: true,
      });

      const rangeResult = await helpers.getCategoryTrackerTransactions({
        id: rangeTracker.id,
        raw: true,
      });
      expect(rangeResult.total).toBe(3);
      expect(rangeResult.transactions.map((t) => t.effectiveRefAmount).toSorted()).toEqual([300, 400, 500]);

      const startOnlyResult = await helpers.getCategoryTrackerTransactions({
        id: startOnlyTracker.id,
        raw: true,
      });
      expect(startOnlyResult.total).toBe(5);
      expect(startOnlyResult.transactions.map((t) => t.effectiveRefAmount).toSorted()).toEqual([
        300, 400, 500, 600, 700,
      ]);

      const endOnlyResult = await helpers.getCategoryTrackerTransactions({
        id: endOnlyTracker.id,
        raw: true,
      });
      expect(endOnlyResult.total).toBe(5);
      expect(endOnlyResult.transactions.map((t) => t.effectiveRefAmount).toSorted()).toEqual([100, 200, 300, 400, 500]);
    }, 60_000);
  });

  describe('AI Categorization Simulation', () => {
    /**
     * These tests simulate what happens after AI categorization assigns a category
     * to a transaction. Since AI categorization is an async background process,
     * we simulate its effect by creating transactions without a category and then
     * updating them to have a category (which is what AI categorization does).
     */

    it('counts a batch of transactions once AI categorization assigns the tracker category', async () => {
      const category = await helpers.addCustomCategory({
        name: 'AI Target Category',
        color: '#FF0000',
        raw: true,
      });

      const tracker = await helpers.createTracker({
        name: 'AI Tracked Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category.id],
        limitAmount: 1000,
        raw: true,
      });

      const account = await helpers.createAccount({ raw: true });

      const transactions = await Promise.all(
        [30, 45, 25].map((amount) =>
          helpers.createTransaction({
            payload: helpers.buildTransactionPayload({
              accountId: account.id,
              amount,
              transactionType: TRANSACTION_TYPES.expense,
            }),
            raw: true,
          }),
        ),
      );

      let stats = await helpers.getTrackerStats({ id: tracker.id, raw: true });
      expect(stats!.summary.actualExpense).toBe(0);
      expect(stats!.summary.transactionsCount).toBe(0);

      await Promise.all(
        transactions.map(([tx]) =>
          helpers.updateTransaction({
            id: tx.id,
            payload: { categoryId: category.id },
            raw: true,
          }),
        ),
      );

      stats = await helpers.getTrackerStats({ id: tracker.id, raw: true });
      expect(stats!.summary.actualExpense).toBe(100);
      expect(stats!.summary.transactionsCount).toBe(3);
      expect(stats!.summary.utilizationRate).toBeCloseTo((100 / 1000) * 100, 1);
    }, 60_000);

    it('handles AI re-categorization (category changed by AI)', async () => {
      const category1 = await helpers.addCustomCategory({ name: 'Groceries', color: '#FF0000', raw: true });
      const category2 = await helpers.addCustomCategory({ name: 'Restaurants', color: '#00FF00', raw: true });

      // Tracker for Groceries
      const groceryTracker = await helpers.createTracker({
        name: 'Grocery Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category1.id],
        raw: true,
      });

      // Tracker for Restaurants
      const restaurantTracker = await helpers.createTracker({
        name: 'Restaurant Tracker',
        type: TRACKER_TYPES.category,
        categoryIds: [category2.id],
        raw: true,
      });

      const account = await helpers.createAccount({ raw: true });

      // Transaction initially categorized as Groceries by first AI pass
      const [tx] = await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: account.id,
          amount: 50,
          transactionType: TRANSACTION_TYPES.expense,
          categoryId: category1.id,
        }),
        raw: true,
      });

      // Verify counts in both trackers
      let groceryStats = await helpers.getTrackerStats({ id: groceryTracker.id, raw: true });
      let restaurantStats = await helpers.getTrackerStats({ id: restaurantTracker.id, raw: true });

      expect(groceryStats!.summary.actualExpense).toBe(50);
      expect(restaurantStats!.summary.actualExpense).toBe(0);

      // Simulate: User corrects or AI re-categorizes to Restaurants
      await helpers.updateTransaction({
        id: tx.id,
        payload: { categoryId: category2.id },
        raw: true,
      });

      // Verify counts updated correctly
      groceryStats = await helpers.getTrackerStats({ id: groceryTracker.id, raw: true });
      restaurantStats = await helpers.getTrackerStats({ id: restaurantTracker.id, raw: true });

      expect(groceryStats!.summary.actualExpense).toBe(0);
      expect(restaurantStats!.summary.actualExpense).toBe(50);
    });
  });
});
