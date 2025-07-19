// jupiter_api.js - Module pour toutes les interactions Jupiter
const { Connection, PublicKey, VersionedTransaction } = require('@solana/web3.js');

class JupiterAPI {
    constructor(wallet, connection, backupConnections = [], maxSlippage = 10) {
        this.wallet = wallet;
        this.connection = connection;
        this.backupConnections = backupConnections;
        this.maxSlippage = maxSlippage;
        
        // Rate limiting
        this.lastRpcCall = 0;
        this.rpcCallDelay = 2000;
        
        // Cache pour les soldes
        this.balanceCache = new Map();
        this.cacheTimeout = 60000;
    }

    // RATE LIMITING
    async waitForRateLimit() {
        const now = Date.now();
        const timeSinceLastCall = now - this.lastRpcCall;
        
        if (timeSinceLastCall < this.rpcCallDelay) {
            const waitTime = this.rpcCallDelay - timeSinceLastCall;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        this.lastRpcCall = Date.now();
    }

    async getConnection(attempt = 0) {
        if (attempt === 0) {
            return this.connection;
        } else if (attempt <= this.backupConnections.length) {
            return this.backupConnections[attempt - 1];
        } else {
            return this.connection;
        }
    }

    // VÉRIFICATION DES SOLDES AVEC CACHE
    async checkWalletBalance(tokenMint, requiredAmount, useCache = true) {
        try {
            const cacheKey = `${tokenMint}_${this.wallet.publicKey.toString()}`;
            
            if (useCache && this.balanceCache.has(cacheKey)) {
                const cached = this.balanceCache.get(cacheKey);
                if (Date.now() - cached.timestamp < this.cacheTimeout) {
                    return cached.balance >= requiredAmount;
                }
            }

            await this.waitForRateLimit();

            let balance;
            let attempts = 0;
            const maxAttempts = 3;

            while (attempts < maxAttempts) {
                try {
                    const connection = await this.getConnection(attempts);
                    
                    if (tokenMint === 'So11111111111111111111111111111111111111112') {
                        const lamports = await connection.getBalance(this.wallet.publicKey);
                        balance = lamports / 1e9;
                        const requiredSol = requiredAmount / 1e9;
                        
                        this.balanceCache.set(cacheKey, { 
                            balance: lamports, 
                            timestamp: Date.now() 
                        });
                        
                        return balance >= requiredSol + 0.01;
                    } else {
                        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
                            this.wallet.publicKey,
                            { mint: new PublicKey(tokenMint) }
                        );
                        
                        if (tokenAccounts.value.length === 0) return false;
                        
                        balance = parseFloat(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
                        
                        this.balanceCache.set(cacheKey, { 
                            balance: balance, 
                            timestamp: Date.now() 
                        });
                        
                        return balance >= requiredAmount;
                    }
                } catch (rpcError) {
                    attempts++;
                    if (rpcError.message.includes('429')) {
                        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempts) * 1000));
                    } else if (attempts >= maxAttempts) {
                        throw rpcError;
                    }
                }
            }
        } catch (error) {
            console.error(`❌ Erreur vérification solde: ${error.message}`);
            return false;
        }
    }

    // JUPITER API - OBTENIR QUOTE
    async getJupiterQuote(inputMint, outputMint, amount, skipBalanceCheck = false) {
        try {
            // Vérifier solde seulement si demandé
            if (!skipBalanceCheck) {
                const hasBalance = await this.checkWalletBalance(inputMint, amount);
                if (!hasBalance) {
                    console.log(`❌ Solde insuffisant`);
                    return null;
                }
            }

            const response = await fetch(
                `https://quote-api.jup.ag/v6/quote?` +
                `inputMint=${inputMint}&` +
                `outputMint=${outputMint}&` +
                `amount=${amount}&` +
                `slippageBps=${Math.max(this.maxSlippage * 100, 1000)}&` + // Minimum 10% slippage
                `onlyDirectRoutes=false&` +
                `asLegacyTransaction=false`,
                {
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            if (response.ok) {
                const quote = await response.json();
                
                if (quote.error) {
                    console.log(`❌ Jupiter error: ${quote.error}`);
                    return null;
                }
                
                if (quote.outAmount && parseFloat(quote.outAmount) > 0) {
                    return quote;
                }
            } else if (response.status === 429) {
                console.log(`⚠️ Rate limit Jupiter - attendre...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                return null;
            }
            
            return null;
            
        } catch (error) {
            console.log(`❌ Erreur Jupiter quote: ${error.message}`);
            return null;
        }
    }

    // JUPITER API - EXÉCUTER SWAP
    async executeSwap(quote) {
        try {
            const hasBalance = await this.checkWalletBalance(quote.inputMint, parseFloat(quote.inAmount));
            if (!hasBalance) {
                console.log(`❌ Solde insuffisant au moment du swap`);
                return null;
            }

            const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse: quote,
                    userPublicKey: this.wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: 'auto'
                })
            });
            
            if (!swapResponse.ok) {
                throw new Error(`Swap API error: ${swapResponse.status}`);
            }
            
            const { swapTransaction } = await swapResponse.json();
            if (!swapTransaction) {
                throw new Error('Pas de transaction reçue');
            }
            
            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            transaction.sign([this.wallet]);
            
            let txid = null;
            let attempts = 0;
            const maxAttempts = 3;
            
            while (attempts < maxAttempts && !txid) {
                try {
                    attempts++;
                    txid = await this.connection.sendTransaction(transaction, {
                        preflightCommitment: 'confirmed',
                        maxRetries: 0,
                        skipPreflight: false
                    });
                    
                    if (txid) break;
                } catch (sendError) {
                    if (sendError.message.includes('simulation failed') || 
                        sendError.message.includes('insufficient funds')) {
                        throw sendError;
                    }
                    
                    if (attempts < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
            }
            
            if (!txid) {
                throw new Error(`Impossible d'envoyer après ${maxAttempts} tentatives`);
            }
            
            const confirmed = await this.confirmTransactionPolling(txid);
            
            if (confirmed) {
                console.log(`✅ Transaction confirmée: ${txid}`);
                return txid;
            } else {
                console.log(`⚠️ Timeout confirmation: ${txid}`);
                return txid;
            }
            
        } catch (error) {
            console.error(`❌ Erreur swap: ${error.message}`);
            return null;
        }
    }

    // CONFIRMATION TRANSACTION PAR POLLING
    async confirmTransactionPolling(txid, maxRetries = 30) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await this.waitForRateLimit();
                
                const status = await this.connection.getSignatureStatus(txid);
                
                if (status?.value?.confirmationStatus === 'confirmed' || 
                    status?.value?.confirmationStatus === 'finalized') {
                    return true;
                }
                
                if (status?.value?.err) {
                    console.log(`❌ Transaction échouée: ${JSON.stringify(status.value.err)}`);
                    return false;
                }
                
                await new Promise(resolve => setTimeout(resolve, 2000));
                
            } catch (error) {
                if (i === maxRetries - 1) return false;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        return false;
    }

    // TEST DE VENDABILITÉ
    async testTokenSellability(tokenAddress) {
        try {
            console.log(`🧪 Test vendabilité ${tokenAddress.slice(0,8)}...`);
            
            // Vérifier l'adresse Solana (43 ou 44 caractères possibles)
            if (!tokenAddress || tokenAddress.length < 43 || tokenAddress.length > 44) {
                console.log(`   🔍 Adresse complète: ${tokenAddress}`);
                console.log(`   📏 Longueur: ${tokenAddress ? tokenAddress.length : 'undefined'}`);
                return { canSell: false, reason: `Adresse invalide (longueur: ${tokenAddress ? tokenAddress.length : 'undefined'})` };
            }
            
            const solMint = 'So11111111111111111111111111111111111111112';
            const testAmount = 1000000; // 1M de tokens de test
            
            console.log(`   🔍 Test route Jupiter: ${tokenAddress} → SOL`);
            
            const response = await fetch(
                `https://quote-api.jup.ag/v6/quote?` +
                `inputMint=${tokenAddress}&` +
                `outputMint=${solMint}&` +
                `amount=${testAmount}&` +
                `slippageBps=1000&` +
                `onlyDirectRoutes=false`, // Autoriser routes indirectes
                {
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            console.log(`   📡 Jupiter response status: ${response.status}`);
            
            if (response.ok) {
                const quote = await response.json();
                
                if (quote.error) {
                    console.log(`   ❌ Jupiter error détaillée: ${quote.error}`);
                    
                    if (quote.error.includes('No routes found')) {
                        return { canSell: false, reason: 'Aucune route Jupiter trouvée' };
                    } else if (quote.error.includes('Token not found')) {
                        return { canSell: false, reason: 'Token non reconnu par Jupiter' };
                    } else {
                        return { canSell: false, reason: `Jupiter: ${quote.error}` };
                    }
                }
                
                if (quote.outAmount && parseFloat(quote.outAmount) > 0) {
                    const outSol = parseFloat(quote.outAmount) / 1e9;
                    console.log(`   ✅ Route trouvée: ${testAmount.toLocaleString()} tokens → ${outSol.toFixed(8)} SOL`);
                    console.log(`   🛣️ Route: ${quote.routePlan?.length || 'N/A'} étapes`);
                    return { canSell: true, reason: 'Route Jupiter confirmée' };
                } else {
                    console.log(`   ❌ Quote invalide - outAmount: ${quote.outAmount}`);
                    return { canSell: false, reason: 'Quote Jupiter invalide' };
                }
                
            } else if (response.status === 429) {
                console.log(`   ⚠️ Rate limit Jupiter - on continue...`);
                return { canSell: true, reason: 'Rate limit - route probablement OK' };
            } else {
                const errorText = await response.text().catch(() => 'Unknown error');
                console.log(`   ❌ Jupiter API ${response.status}: ${errorText}`);
                return { canSell: false, reason: `API Error ${response.status}` };
            }
            
        } catch (error) {
            console.log(`   ❌ Erreur réseau: ${error.message}`);
            return { canSell: false, reason: `Erreur: ${error.message}` };
        }
    }

    // OBTENIR SOLDE RÉEL D'UN TOKEN
    async getRealTokenBalance(tokenMint) {
        try {
            await this.waitForRateLimit();
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                this.wallet.publicKey,
                { mint: new PublicKey(tokenMint) }
            );
            
            if (tokenAccounts.value.length === 0) return 0;
            return parseFloat(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
        } catch (error) {
            console.error(`❌ Erreur lecture solde token: ${error.message}`);
            return 0;
        }
    }

    // INVALIDER CACHE POUR UN TOKEN
    invalidateBalanceCache(tokenMint) {
        const cacheKey = `${tokenMint}_${this.wallet.publicKey.toString()}`;
        this.balanceCache.delete(cacheKey);
    }
}

module.exports = JupiterAPI;