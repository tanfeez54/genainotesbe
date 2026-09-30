import { supabaseService } from '../lib/supabase';

// Cashfree Gateway Configuration
const cashfreeAppId = process.env.CASHFREE_APP_ID || '';
const cashfreeSecret = process.env.CASHFREE_SECRET_KEY || '';
const cashfreeEnv = (process.env.CASHFREE_ENV || 'sandbox').toLowerCase();

const isCashfreeConfigured =
  Boolean(cashfreeAppId && cashfreeSecret) &&
  !cashfreeAppId.includes('placeholder') &&
  !cashfreeSecret.includes('placeholder');

const cashfreeBaseUrl =
  cashfreeEnv === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';

export interface BillingSummary {
  school_id: string;
  school_name: string;
  wallet_balance: number;
  cost_per_generation: number;
  generations_remaining: number;
  generations_used: number;
  monthly_generation_quota: number;
  subscription_status: string;
  plan_name: string;
  plan_slug: string;
  price_monthly: number;
  price_yearly: number;
  trial_ends_at: string | null;
  subscription_ends_at: string | null;
  is_trial_expired: boolean;
  can_generate: boolean;
}

export class BillingService {
  /**
   * Get complete billing, subscription, and wallet summary for a school
   */
  static async getBillingSummary(schoolId: string): Promise<BillingSummary> {
    const { data: school, error } = await supabaseService
      .from('schools')
      .select('*, plan:subscription_plans(*)')
      .eq('id', schoolId)
      .single();

    if (error || !school) {
      throw new Error('School not found or billing details unavailable');
    }

    const walletBalance = Number(school.wallet_balance ?? 50.0);
    const costPerGen = Number(school.cost_per_generation ?? 5.0);
    const generationsRemaining = Math.max(0, Math.floor(walletBalance / costPerGen));
    const now = new Date();

    const isTrialExpired =
      school.subscription_status === 'trial' &&
      school.trial_ends_at &&
      new Date(school.trial_ends_at) < now;

    const isSubscriptionActive =
      school.subscription_status === 'active' ||
      (school.subscription_status === 'trial' && !isTrialExpired);

    const canGenerate = isSubscriptionActive && walletBalance >= costPerGen;

    return {
      school_id: school.id,
      school_name: school.name,
      wallet_balance: walletBalance,
      cost_per_generation: costPerGen,
      generations_remaining: generationsRemaining,
      generations_used: Number(school.generations_used ?? 0),
      monthly_generation_quota: Number(school.monthly_generation_quota ?? 10),
      subscription_status: school.subscription_status || 'trial',
      plan_name: school.plan?.name || '14-Day Free Trial',
      plan_slug: school.plan?.slug || 'trial',
      price_monthly: Number(school.plan?.price_monthly ?? 0),
      price_yearly: Number(school.plan?.price_yearly ?? 0),
      trial_ends_at: school.trial_ends_at,
      subscription_ends_at: school.subscription_ends_at,
      is_trial_expired: Boolean(isTrialExpired),
      can_generate: canGenerate,
    };
  }

  /**
   * Check if school has sufficient balance (>= ₹5) and active subscription to generate
   */
  static async checkGenerationAllowance(schoolId: string): Promise<{
    allowed: boolean;
    reason?: string;
    currentBalance: number;
    cost: number;
    generationsRemaining: number;
  }> {
    const summary = await this.getBillingSummary(schoolId);

    if (summary.subscription_status === 'suspended' || summary.subscription_status === 'cancelled') {
      return {
        allowed: false,
        reason: `Your subscription is currently ${summary.subscription_status}. Please contact support or renew.`,
        currentBalance: summary.wallet_balance,
        cost: summary.cost_per_generation,
        generationsRemaining: summary.generations_remaining,
      };
    }

    if (summary.is_trial_expired) {
      return {
        allowed: false,
        reason: 'Your 14-day free trial has expired. Please choose a subscription plan to continue generating question papers.',
        currentBalance: summary.wallet_balance,
        cost: summary.cost_per_generation,
        generationsRemaining: summary.generations_remaining,
      };
    }

    if (summary.wallet_balance < summary.cost_per_generation) {
      return {
        allowed: false,
        reason: `Insufficient balance (₹${summary.wallet_balance.toFixed(2)}). Each generation costs ₹${summary.cost_per_generation.toFixed(2)}. Please recharge your wallet.`,
        currentBalance: summary.wallet_balance,
        cost: summary.cost_per_generation,
        generationsRemaining: summary.generations_remaining,
      };
    }

    return {
      allowed: true,
      currentBalance: summary.wallet_balance,
      cost: summary.cost_per_generation,
      generationsRemaining: summary.generations_remaining,
    };
  }

  /**
   * Atomically deduct ₹5.00 upon successful generation
   */
  static async deductGenerationFee(
    schoolId: string,
    userId?: string,
    paperId?: string,
    description: string = 'AI Question Paper Generation (₹5.00)'
  ): Promise<{ success: boolean; newBalance: number; costDeducted: number }> {
    // 1. Try PostgreSQL RPC first
    try {
      const { data: rpcResult, error: rpcError } = await supabaseService.rpc(
        'deduct_school_generation_fee',
        {
          p_school_id: schoolId,
          p_user_id: userId || null,
          p_paper_id: paperId || null,
          p_description: description,
        }
      );

      if (!rpcError && rpcResult && rpcResult.success) {
        return {
          success: true,
          newBalance: Number(rpcResult.balance_after),
          costDeducted: Number(rpcResult.cost_deducted),
        };
      }
    } catch (e) {
      console.warn('[BillingService] RPC deduction call failed, falling back to query logic:', e);
    }

    // 2. Direct fallback logic
    const { data: school, error: fetchErr } = await supabaseService
      .from('schools')
      .select('id, wallet_balance, cost_per_generation, generations_used')
      .eq('id', schoolId)
      .single();

    if (fetchErr || !school) {
      throw new Error('School not found for balance deduction');
    }

    const cost = Number(school.cost_per_generation ?? 5.0);
    const currentBalance = Number(school.wallet_balance ?? 0);
    if (currentBalance < cost) {
      throw new Error(`Insufficient wallet balance. Required: ₹${cost}, Available: ₹${currentBalance}`);
    }

    const newBalance = Math.max(0, currentBalance - cost);
    const newGenerationsUsed = (Number(school.generations_used) || 0) + 1;

    // Update school record
    const { error: updateErr } = await supabaseService
      .from('schools')
      .update({
        wallet_balance: newBalance,
        generations_used: newGenerationsUsed,
      })
      .eq('id', schoolId);

    if (updateErr) {
      throw new Error(`Failed to update school balance: ${updateErr.message}`);
    }

    // Insert wallet transaction record safely
    try {
      await supabaseService.from('wallet_transactions').insert([
        {
          school_id: schoolId,
          user_id: userId || null,
          amount: -cost,
          type: 'generation_fee',
          description,
          reference_id: paperId || null,
          balance_after: newBalance,
        },
      ]);
    } catch (txErr) {
      console.warn('[BillingService] Failed to insert wallet transaction record:', txErr);
    }

    return {
      success: true,
      newBalance,
      costDeducted: cost,
    };
  }

  /**
   * Calculate tiered bonus credits for higher recharge amounts:
   * - >= ₹1,000: +30% Bonus (e.g. ₹1000 -> ₹1300 = 260 gens)
   * - >= ₹500:   +25% Bonus (e.g. ₹500  -> ₹625  = 125 gens)
   * - >= ₹250:   +20% Bonus (e.g. ₹250  -> ₹300  = 60 gens)
   * - >= ₹100:   +10% Bonus (e.g. ₹100  -> ₹110  = 22 gens)
   * - < ₹100:    Standard rate (e.g. ₹50 = 10 gens)
   */
  static calculateBonusCredits(amount: number): {
    amount: number;
    bonusPercent: number;
    bonusAmount: number;
    totalCredit: number;
    totalGenerations: number;
    bonusGenerations: number;
  } {
    let bonusPercent = 0;
    if (amount >= 1000) {
      bonusPercent = 50;
    } else if (amount >= 500) {
      bonusPercent = 20;
    } else if (amount >= 250) {
      bonusPercent = 15;
    } else if (amount >= 100) {
      bonusPercent = 10;
    }

    const bonusAmount = Math.round((amount * bonusPercent) / 100);
    const totalCredit = amount + bonusAmount;
    const totalGenerations = Math.floor(totalCredit / 5);
    const bonusGenerations = Math.floor(bonusAmount / 5);

    return {
      amount,
      bonusPercent,
      bonusAmount,
      totalCredit,
      totalGenerations,
      bonusGenerations,
    };
  }

  /**
   * Create Cashfree Order for wallet recharge or subscription plan
   */
  static async createOrder(
    schoolId: string,
    userId: string,
    amount: number,
    type: 'wallet_recharge' | 'subscription',
    planId?: string
  ): Promise<{
    orderId: string;
    paymentSessionId: string;
    amount: number;
    currency: string;
    isMock: boolean;
    mode: string;
  }> {
    if (amount <= 0) {
      throw new Error('Order amount must be greater than zero');
    }

    const orderId = `cf_${schoolId.slice(0, 8)}_${Date.now()}`;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    // If Cashfree API credentials are set, create live/sandbox order via Cashfree PG API
    if (isCashfreeConfigured) {
      try {
        // Fetch user / school details for customer info
        const { data: school } = await supabaseService
          .from('schools')
          .select('name, contact_email, phone')
          .eq('id', schoolId)
          .single();

        const response = await fetch(`${cashfreeBaseUrl}/orders`, {
          method: 'POST',
          headers: {
            'x-client-id': cashfreeAppId,
            'x-client-secret': cashfreeSecret,
            'x-api-version': '2023-08-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            order_id: orderId,
            order_amount: Number(amount.toFixed(2)),
            order_currency: 'INR',
            customer_details: {
              customer_id: userId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || 'cust_user',
              customer_email: school?.contact_email || 'billing@school.com',
              customer_phone: (school?.phone || '9999999999').replace(/[^0-9]/g, '').slice(-10) || '9999999999',
              customer_name: school?.name || 'School Administrator',
            },
            order_meta: {
              return_url: `${frontendUrl}/billing?order_id={order_id}`,
              notify_url: `${process.env.BACKEND_URL || 'http://localhost:4000'}/api/billing/webhook`,
            },
            order_note: type === 'wallet_recharge' ? 'School Wallet Top-up' : 'School Subscription Plan',
          }),
        });

        const data: any = await response.json();

        if (!response.ok || !data.payment_session_id) {
          console.error('[Cashfree API Error]', data);
          throw new Error(data.message || 'Failed to create order with Cashfree');
        }

        // Record pending invoice
        await supabaseService.from('invoices').insert([
          {
            school_id: schoolId,
            plan_id: planId || null,
            amount,
            currency: 'INR',
            status: 'pending',
            type,
            payment_gateway: 'cashfree',
            razorpay_order_id: orderId, // stored in standard order_id column
          },
        ]);

        return {
          orderId: data.order_id,
          paymentSessionId: data.payment_session_id,
          amount,
          currency: 'INR',
          isMock: false,
          mode: cashfreeEnv,
        };
      } catch (err: any) {
        console.error('[BillingService] Cashfree order creation failed:', err);
        throw new Error(err.message || 'Cashfree order creation failed');
      }
    }

    // Otherwise create simulated test order for local testing / demo mode
    const mockOrderId = `cf_mock_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    await supabaseService.from('invoices').insert([
      {
        school_id: schoolId,
        plan_id: planId || null,
        amount,
        currency: 'INR',
        status: 'pending',
        type,
        payment_gateway: 'mock_test',
        razorpay_order_id: mockOrderId,
      },
    ]);

    return {
      orderId: mockOrderId,
      paymentSessionId: `mock_session_${Date.now()}`,
      amount,
      currency: 'INR',
      isMock: true,
      mode: 'sandbox',
    };
  }

  /**
   * Verify Cashfree order and credit wallet or activate subscription plan
   */
  static async verifyAndProcessPayment(params: {
    schoolId: string;
    userId: string;
    orderId: string;
    amount: number;
    type: 'wallet_recharge' | 'subscription';
    planId?: string;
    billingCycle?: 'monthly' | 'yearly' | 'lifetime';
  }): Promise<{ success: boolean; newBalance: number; message: string }> {
    const { schoolId, userId, orderId, amount, type, planId, billingCycle } = params;

    // Verify order status directly with Cashfree API if configured
    if (isCashfreeConfigured && !orderId.startsWith('cf_mock_')) {
      try {
        const verifyRes = await fetch(`${cashfreeBaseUrl}/orders/${orderId}`, {
          method: 'GET',
          headers: {
            'x-client-id': cashfreeAppId,
            'x-client-secret': cashfreeSecret,
            'x-api-version': '2023-08-01',
          },
        });

        const verifyData: any = await verifyRes.json();
        if (!verifyRes.ok) {
          throw new Error(verifyData.message || 'Could not verify payment with Cashfree');
        }

        if (verifyData.order_status !== 'PAID') {
          throw new Error(`Payment is not completed. Cashfree status: ${verifyData.order_status}`);
        }
      } catch (err: any) {
        console.error('[Cashfree Verification Error]', err);
        throw new Error(err.message || 'Cashfree verification failed');
      }
    }

    // Process based on type
    if (type === 'wallet_recharge') {
      const bonusInfo = this.calculateBonusCredits(amount);
      const desc =
        bonusInfo.bonusPercent > 0
          ? `Wallet Recharge (Paid ₹${amount} + ₹${bonusInfo.bonusAmount} [${bonusInfo.bonusPercent}% Bonus] = ₹${bonusInfo.totalCredit} [${bonusInfo.totalGenerations} generations])`
          : `Wallet Recharge (+₹${amount.toFixed(2)})`;

      const rechargeResult = await this.creditWallet(
        schoolId,
        userId,
        bonusInfo.totalCredit,
        orderId,
        desc
      );

      // Mark invoice as paid
      await supabaseService
        .from('invoices')
        .update({
          status: 'paid',
          razorpay_payment_id: orderId,
          paid_at: new Date().toISOString(),
        })
        .eq('razorpay_order_id', orderId);

      return {
        success: true,
        newBalance: rechargeResult.newBalance,
        message:
          bonusInfo.bonusPercent > 0
            ? `Successfully added ₹${bonusInfo.totalCredit} (including ₹${bonusInfo.bonusAmount} [${bonusInfo.bonusPercent}%] free bonus for ${bonusInfo.totalGenerations} generations)!`
            : `Successfully added ₹${amount.toFixed(2)} to your wallet!`,
      };
    } else {
      // Subscription plan purchase / upgrade
      const subResult = await this.activateSubscription(
        schoolId,
        userId,
        planId!,
        amount,
        billingCycle || 'monthly',
        orderId
      );

      // Mark invoice as paid
      await supabaseService
        .from('invoices')
        .update({
          status: 'paid',
          razorpay_payment_id: orderId,
          paid_at: new Date().toISOString(),
        })
        .eq('razorpay_order_id', orderId);

      return {
        success: true,
        newBalance: subResult.newBalance,
        message: `Plan activated successfully! Included generations have been added to your balance.`,
      };
    }
  }

  /**
   * Credit school wallet with bonus or topup amount
   */
  static async creditWallet(
    schoolId: string,
    userId: string,
    amount: number,
    refId?: string,
    description: string = 'Wallet Topup'
  ): Promise<{ newBalance: number }> {
    // 1. Try RPC
    try {
      const { data: rpcResult, error: rpcError } = await supabaseService.rpc('credit_school_wallet', {
        p_school_id: schoolId,
        p_user_id: userId,
        p_amount: amount,
        p_ref_id: refId || null,
        p_desc: description,
      });

      if (!rpcError && rpcResult && rpcResult.success) {
        return { newBalance: Number(rpcResult.balance_after) };
      }
    } catch (e) {
      console.warn('[BillingService] credit_school_wallet RPC call failed, falling back:', e);
    }

    // 2. Direct query fallback
    const { data: school } = await supabaseService
      .from('schools')
      .select('wallet_balance')
      .eq('id', schoolId)
      .single();

    const currentBalance = Number(school?.wallet_balance ?? 0);
    const newBalance = currentBalance + amount;

    await supabaseService
      .from('schools')
      .update({ wallet_balance: newBalance })
      .eq('id', schoolId);

    try {
      await supabaseService.from('wallet_transactions').insert([
        {
          school_id: schoolId,
          user_id: userId,
          amount,
          type: 'topup',
          description,
          reference_id: refId || null,
          balance_after: newBalance,
        },
      ]);
    } catch (txErr) {
      console.warn('[BillingService] Failed to record wallet transaction:', txErr);
    }

    return { newBalance };
  }

  /**
   * Activate One-Time Lifetime Membership plan for a school
   */
  static async activateSubscription(
    schoolId: string,
    userId: string,
    planId: string,
    _amountPaid: number,
    _billingCycle: string = 'lifetime',
    paymentRef: string
  ): Promise<{ newBalance: number }> {
    const { data: plan, error: planErr } = await supabaseService
      .from('subscription_plans')
      .select('*')
      .eq('id', planId)
      .single();

    if (planErr || !plan) {
      throw new Error('Subscription plan not found');
    }

    const now = new Date();
    const includedGens = Number(plan.included_generations_per_month ?? 60);
    const includedBonusValue = includedGens * Number(plan.cost_per_extra_generation ?? 5.0);

    // Get current balance
    const { data: school } = await supabaseService
      .from('schools')
      .select('wallet_balance')
      .eq('id', schoolId)
      .single();

    const currentBalance = Number(school?.wallet_balance ?? 0);
    const newBalance = currentBalance + includedBonusValue;

    // Lifetime membership never expires (subscription_ends_at is null)
    await supabaseService
      .from('schools')
      .update({
        plan_id: plan.id,
        subscription_status: 'active',
        subscription_starts_at: now.toISOString(),
        subscription_ends_at: null,
        billing_cycle: 'lifetime',
        monthly_generation_quota: includedGens,
        cost_per_generation: Number(plan.cost_per_extra_generation ?? 5.0),
        wallet_balance: newBalance,
      })
      .eq('id', schoolId);

    // Record wallet credit for included quota safely
    try {
      await supabaseService.from('wallet_transactions').insert([
        {
          school_id: schoolId,
          user_id: userId,
          amount: includedBonusValue,
          type: 'plan_quota',
          description: `Lifetime Membership: ${plan.name} (+₹${includedBonusValue} credits for ${includedGens} generations)`,
          reference_id: paymentRef,
          balance_after: newBalance,
        },
      ]);
    } catch (txErr) {
      console.warn('[BillingService] Failed to record plan quota transaction:', txErr);
    }

    return { newBalance };
  }

  /**
   * Get list of all available subscription plans
   */
  static async getAvailablePlans() {
    const { data: plans, error } = await supabaseService
      .from('subscription_plans')
      .select('*')
      .eq('is_active', true)
      .order('price_monthly', { ascending: true });

    if (error) {
      throw new Error(`Failed to load subscription plans: ${error.message}`);
    }

    return plans;
  }

  /**
   * Get recent wallet transactions for school
   */
  static async getTransactions(schoolId: string, limit = 50) {
    try {
      const { data: transactions, error } = await supabaseService
        .from('wallet_transactions')
        .select('*')
        .eq('school_id', schoolId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        console.warn('[BillingService] wallet_transactions query:', error.message);
        return [];
      }

      return transactions || [];
    } catch (err: any) {
      console.warn('[BillingService] wallet_transactions not ready:', err.message);
      return [];
    }
  }
}
