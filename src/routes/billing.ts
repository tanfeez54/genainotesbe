import { Router } from 'express';
import { z } from 'zod';
import { requireSchoolAccess } from '../middleware/schoolAccess';
import { BillingService } from '../services/billingService';
import type { Request, Response } from 'express';

const router = Router();

// Apply school access middleware to all billing endpoints
// Super admins, school admins, and teachers can view; only admins can pay / recharge
router.use(requireSchoolAccess(['super_admin', 'school_admin', 'teacher', 'data_entry']));

/**
 * GET /api/billing/summary
 * Fetch school wallet balance, remaining generations, active plan, and status
 */
router.get('/summary', async (req: Request, res: Response): Promise<void> => {
  try {
    const schoolId = req.school_id;
    if (!schoolId) {
      res.status(400).json({ error: 'School ID missing from context' });
      return;
    }

    const summary = await BillingService.getBillingSummary(schoolId);
    res.json({ success: true, data: summary });
  } catch (err: any) {
    console.error('[BillingRoute] Summary error:', err);
    res.status(500).json({ error: err.message || 'Failed to load billing summary' });
  }
});

/**
 * GET /api/billing/plans
 * List all available subscription plans
 */
router.get('/plans', async (_req: Request, res: Response): Promise<void> => {
  try {
    const plans = await BillingService.getAvailablePlans();
    res.json({ success: true, data: plans });
  } catch (err: any) {
    console.error('[BillingRoute] Plans error:', err);
    res.status(500).json({ error: err.message || 'Failed to load plans' });
  }
});

/**
 * GET /api/billing/transactions
 * Retrieve transaction history for the school wallet
 */
router.get('/transactions', async (req: Request, res: Response): Promise<void> => {
  try {
    const schoolId = req.school_id;
    if (!schoolId) {
      res.status(400).json({ error: 'School ID missing' });
      return;
    }

    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 50));
    const transactions = await BillingService.getTransactions(schoolId, limit);
    res.json({ success: true, data: transactions });
  } catch (err: any) {
    console.error('[BillingRoute] Transactions error:', err);
    res.status(500).json({ error: err.message || 'Failed to load transactions' });
  }
});

/**
 * POST /api/billing/create-order
 * Create a Razorpay order for wallet topup or subscription plan purchase
 */
router.post('/create-order', async (req: Request, res: Response): Promise<void> => {
  try {
    const schoolId = req.school_id;
    const userId = req.userId;
    if (!schoolId || !userId) {
      res.status(401).json({ error: 'Unauthorized school session' });
      return;
    }

    const schema = z.object({
      amount: z.number().min(1, 'Amount must be at least ₹1'),
      type: z.enum(['wallet_recharge', 'subscription']),
      planId: z.string().uuid().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid parameters', details: parsed.error.issues });
      return;
    }

    const orderData = await BillingService.createOrder(
      schoolId,
      userId,
      parsed.data.amount,
      parsed.data.type,
      parsed.data.planId
    );

    res.json({ success: true, data: orderData });
  } catch (err: any) {
    console.error('[BillingRoute] Order error:', err);
    res.status(500).json({ error: err.message || 'Failed to create payment order' });
  }
});

/**
 * POST /api/billing/verify-payment
 * Verify signature and credit wallet or activate subscription
 */
router.post('/verify-payment', async (req: Request, res: Response): Promise<void> => {
  try {
    const schoolId = req.school_id;
    const userId = req.userId;
    if (!schoolId || !userId) {
      res.status(401).json({ error: 'Unauthorized school session' });
      return;
    }

    const schema = z.object({
      orderId: z.string().min(1),
      paymentId: z.string().optional(),
      signature: z.string().optional(),
      amount: z.number().min(1),
      type: z.enum(['wallet_recharge', 'subscription']),
      planId: z.string().uuid().optional(),
      billingCycle: z.enum(['monthly', 'yearly', 'lifetime']).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid verification payload', details: parsed.error.issues });
      return;
    }

    const result = await BillingService.verifyAndProcessPayment({
      schoolId,
      userId,
      orderId: parsed.data.orderId,
      amount: parsed.data.amount,
      type: parsed.data.type,
      planId: parsed.data.planId,
      billingCycle: parsed.data.billingCycle,
    });

    res.json({ ...result });
  } catch (err: any) {
    console.error('[BillingRoute] Verify error:', err);
    res.status(400).json({ error: err.message || 'Payment verification failed' });
  }
});

/**
 * POST /api/billing/mock-recharge
 * Instant wallet recharge for testing/demo without needing live Razorpay keys
 */
router.post('/mock-recharge', async (req: Request, res: Response): Promise<void> => {
  try {
    const schoolId = req.school_id;
    const userId = req.userId;
    if (!schoolId || !userId) {
      res.status(401).json({ error: 'Unauthorized school session' });
      return;
    }

    const schema = z.object({
      amount: z.number().min(5, 'Minimum recharge is ₹5').max(50000, 'Maximum recharge is ₹50,000'),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid amount', details: parsed.error.issues });
      return;
    }

    const bonusInfo = BillingService.calculateBonusCredits(parsed.data.amount);
    const desc =
      bonusInfo.bonusPercent > 0
        ? `Instant Top-up (+₹${parsed.data.amount} + ₹${bonusInfo.bonusAmount} [${bonusInfo.bonusPercent}% Bonus] = ₹${bonusInfo.totalCredit} [${bonusInfo.totalGenerations} gens])`
        : `Instant Top-up (+₹${parsed.data.amount.toFixed(2)})`;

    const mockPaymentId = `pay_mock_${Date.now()}`;
    const result = await BillingService.creditWallet(
      schoolId,
      userId,
      bonusInfo.totalCredit,
      mockPaymentId,
      desc
    );

    res.json({
      success: true,
      newBalance: result.newBalance,
      bonusCredited: bonusInfo.bonusAmount,
      totalCredit: bonusInfo.totalCredit,
      message:
        bonusInfo.bonusPercent > 0
          ? `Successfully recharged ₹${parsed.data.amount} + ₹${bonusInfo.bonusAmount} Bonus (${bonusInfo.bonusPercent}% extra)! Total ₹${bonusInfo.totalCredit} added (${bonusInfo.totalGenerations} generations).`
          : `Successfully recharged ₹${parsed.data.amount.toFixed(2)} to wallet!`,
    });
  } catch (err: any) {
    console.error('[BillingRoute] Mock recharge error:', err);
    res.status(500).json({ error: err.message || 'Failed to recharge wallet' });
  }
});

export default router;
