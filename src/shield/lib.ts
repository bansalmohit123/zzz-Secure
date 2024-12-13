// src/algorithm/ArcjetShield.ts
import { InMemoryStore } from './memory/inMemoryStore';
import { Request, Response, NextFunction } from 'express';
import { handleAsyncErrors } from '../parseConfig';
import { StoreInterface } from './memory/memoryInterface';
import { detectLfiPatterns, detectSQLInjectionPatterns, detectXSSPatterns } from './detection-patterns';

type SuspicionScore = {
    score: number;
    resetTime: number;
};

interface ShieldOptions {
    suspicionThreshold?: number;
    blockDurationMs?: number;
    detectionPatterns?: Array<RegExp>;
    message?: string;
    csrf?: boolean;
    xss?: boolean;
    sqlInjection?: boolean;
    lfi?: boolean;
    rfi?: boolean;
    shellInjection?: boolean;
    store?: StoreInterface;
}

export function isAttackDetected(
    input: object,
    patterns: RegExp[]
): boolean {
    const values = Object.values(input);
    return values.some(value =>
        typeof value === "string" && patterns.some(pattern => pattern.test(value))
    );
}

export function detectMaliciousRequest(
    req: any,
    options: ShieldOptions
): { isSuspicious: boolean; attackTypes: string[] } {
    const attackTypes: string[] = [];

    // Check enabled attack detection options
    if (options.xss && isAttackDetected({ ...req.query, ...req.body, ...req.params }, detectXSSPatterns)) {
        attackTypes.push("XSS");
    }
    if (options.sqlInjection && isAttackDetected({ ...req.query, ...req.body, ...req.params }, detectSQLInjectionPatterns)) {
        attackTypes.push("SQL Injection");
    }
    if (options.lfi && isAttackDetected({ ...req.query, ...req.body, ...req.params }, detectLfiPatterns)) {
        attackTypes.push("LFI");
    }

    return {
        isSuspicious: attackTypes.length > 0,
        attackTypes,
    };
}

export default class ZShield {
    private suspicionThreshold: number;
    private blockDurationMs: number;
    private memoryStore: StoreInterface;
    private options: ShieldOptions;

    constructor(options: Partial<ShieldOptions> = {}) {
        this.options = {
            message: "Access denied due to suspicious activity.",
            suspicionThreshold: 5,
            blockDurationMs: 60000,
            csrf: true,
            xss: true,
            sqlInjection: true,
            lfi: true,
            rfi: true,
            shellInjection: true,
            store: new InMemoryStore(),
            ...options,
        };

        this.memoryStore = this.options.store!;
        this.suspicionThreshold = this.options.suspicionThreshold ?? 5;
        this.blockDurationMs = this.options.blockDurationMs ?? 60000;
    }

    middleware = handleAsyncErrors(
        async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            const clientIP = req.ip;

            if (!clientIP) {
                res.status(403).json({ error: this.options.message });
                return;
            }

            // Check if the client is already blocked
            const isBlocked = await this.memoryStore.isBlocked(clientIP);
            if (isBlocked) {
                res.status(403).json({ error: this.options.message });
                return;
            }

            // Detect attack patterns
            const { isSuspicious, attackTypes } = detectMaliciousRequest(req, this.options);
            if (!isSuspicious) {
                next();
                return;
            }

            // Log detected attack types
            console.log(`Suspicious activity detected from ${clientIP}: ${attackTypes.join(", ")}`);

            // Increment suspicion score
            const currentScore = await this.memoryStore.increment(clientIP, this.blockDurationMs);

            if (currentScore >= this.suspicionThreshold) {                
                res.status(403).json({
                    error: this.options.message,
                    detectedAttacks: attackTypes,
                });
                return;
            }

            next();
        }
    );

    async flushExpiredScores(): Promise<void> {
        await this.memoryStore.flushExpired();
    }
}
