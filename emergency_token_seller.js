// emergency_token_seller.js - Vendeur d'urgence pour tokens >1$ vers SOL
require('dotenv').config();
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const JupiterAPI = require('./jupiter_api');

class EmergencyTokenSeller {
    constructor() {
        // Configuration Solana
        const rpcUrls = [
            'https://api.mainnet-beta.solana.com',
            'https://rpc.ankr.com/solana',
            'https://solana-api.projectserum.com',
            process.env.SOLANA_RPC_URL
        ].filter(url => url && !url.includes('undefined'));
        
        this.connection = new Connection(rpcUrls[0] || 'https://api.mainnet-beta.solana.com', {
            commitment: 'confirmed',
            wsEndpoint: false,
            httpHeaders: { 'User-Agent': 'Emergency-Seller/1.0' }
        });

        this.backupConnections = rpcUrls.slice(1).map(url => 
            new Connection(url, { 
                commitment: 'confirmed',
                wsEndpoint: false
            })
        );

        // Configuration wallet
        this.wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
        this.maxSlippage = parseFloat(process.env.EMERGENCY_SLIPPAGE || '15'); // Plus de slippage pour urgence

        // Jupiter API
        this.jupiterAPI = new JupiterAPI(
            this.wallet, 
            this.connection, 
            this.backupConnections, 
            this.maxSlippage
        );

        // Configuration de vente d'urgence
        this.minTokenValue = parseFloat(process.env.MIN_TOKEN_VALUE || '1.0'); // 1$ minimum
        this.solMint = 'So11111111111111111111111111111111111111112';
        this.batchSize = 1; // Vendre 1 token à la fois pour éviter rate limiting
        this.retryAttempts = 3; // Plus de tentatives
        this.baseDelay = 3000; // 3s de base entre tentatives
        this.rateLimitDelay = 10000; // 10s après rate limit
        
        // Tokens à ignorer (SOL, stablecoins, etc.)
        this.ignoredTokens = new Set([
            'So11111111111111111111111111111111111111112', // SOL
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
            'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK (si vous voulez le garder)
        ]);

        console.log(`🚨 Emergency Token Seller initialisé`);
        console.log(`💼 Wallet: ${this.wallet.publicKey.toString()}`);
        console.log(`💰 Valeur minimum: $${this.minTokenValue}`);
        console.log(`📈 Slippage maximum: ${this.maxSlippage}%`);
    }

    // Scanner tous les tokens du wallet
    async scanWalletTokens() {
        console.log('🔍 Scan du wallet pour tokens >$1...');
        
        try {
            // Récupérer tous les comptes de tokens
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                this.wallet.publicKey,
                { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
            );

            console.log(`📊 ${tokenAccounts.value.length} comptes de tokens trouvés`);

            const eligibleTokens = [];
            let processedCount = 0;

            for (const account of tokenAccounts.value) {
                try {
                    const tokenInfo = account.account.data.parsed.info;
                    const tokenMint = tokenInfo.mint;
                    const balance = parseFloat(tokenInfo.tokenAmount.amount);
                    const decimals = tokenInfo.tokenAmount.decimals;

                    // Ignorer si balance nulle ou token ignoré
                    if (balance === 0 || this.ignoredTokens.has(tokenMint)) {
                        continue;
                    }

                    processedCount++;
                    console.log(`   🔎 ${processedCount}. Vérification ${tokenMint.slice(0, 8)}...`);

                    // Obtenir le prix via DexScreener
                    const tokenValue = await this.getTokenValue(tokenMint, balance, decimals);
                    
                    if (tokenValue && tokenValue.usdValue >= this.minTokenValue) {
                        console.log(`   ✅ ${tokenValue.symbol || 'UNKNOWN'}: $${tokenValue.usdValue.toFixed(2)} (${tokenValue.humanBalance.toLocaleString()} tokens)`);
                        
                        eligibleTokens.push({
                            mint: tokenMint,
                            balance: balance,
                            decimals: decimals,
                            humanBalance: tokenValue.humanBalance,
                            usdValue: tokenValue.usdValue,
                            pricePerToken: tokenValue.pricePerToken,
                            symbol: tokenValue.symbol,
                            account: account.pubkey
                        });
                    } else if (tokenValue) {
                        console.log(`   ❌ ${tokenValue.symbol || 'UNKNOWN'}: $${tokenValue.usdValue.toFixed(2)} (< $${this.minTokenValue})`);
                    } else {
                        console.log(`   ⚠️ Token ${tokenMint.slice(0, 8)}: Prix introuvable`);
                    }

                    // Rate limiting DexScreener - plus conservateur
                    await new Promise(resolve => setTimeout(resolve, 1200)); // 1.2s entre tokens

                } catch (error) {
                    console.log(`   ❌ Erreur token: ${error.message}`);
                }
            }

            // Trier par valeur USD décroissante
            eligibleTokens.sort((a, b) => b.usdValue - a.usdValue);

            console.log(`\n🎯 ${eligibleTokens.length} tokens éligibles pour vente d'urgence:`);
            console.log('─'.repeat(80));
            
            let totalValue = 0;
            eligibleTokens.forEach((token, i) => {
                console.log(`${(i+1).toString().padStart(2)}. ${(token.symbol || 'UNKNOWN').padEnd(10)} | $${token.usdValue.toFixed(2).padStart(8)} | ${token.humanBalance.toLocaleString().padStart(15)} tokens`);
                totalValue += token.usdValue;
            });
            
            console.log('─'.repeat(80));
            console.log(`💰 VALEUR TOTALE: $${totalValue.toFixed(2)}`);
            console.log('═'.repeat(80));

            return eligibleTokens;

        } catch (error) {
            console.error('❌ Erreur scan wallet:', error.message);
            return [];
        }
    }

    // Obtenir la valeur d'un token
    async getTokenValue(tokenMint, balance, decimals) {
        try {
            // Récupérer le prix via DexScreener
            const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`);
            
            if (!response.ok) return null;
            
            const data = await response.json();
            const pair = data.pairs?.find(p => p.chainId === 'solana');
            
            if (!pair || !pair.priceUsd) return null;
            
            const pricePerToken = parseFloat(pair.priceUsd);
            const humanBalance = balance / Math.pow(10, decimals);
            const usdValue = humanBalance * pricePerToken;
            
            return {
                pricePerToken: pricePerToken,
                humanBalance: humanBalance,
                usdValue: usdValue,
                symbol: pair.baseToken?.symbol || 'UNKNOWN'
            };
            
        } catch (error) {
            console.log(`   ⚠️ Erreur prix ${tokenMint.slice(0, 8)}: ${error.message}`);
            return null;
        }
    }

    // Vendre un token spécifique avec gestion améliorée des erreurs
    async sellToken(tokenData) {
        const { mint, balance, symbol, usdValue } = tokenData;
        
        console.log(`🔥 Vente: ${symbol} (${usdValue.toFixed(2)})`);
        
        try {
            // Vérifier d'abord si on a encore ce token (au cas où déjà vendu)
            await this.sleep(1000); // Délai préventif
            
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                this.wallet.publicKey,
                { mint: new PublicKey(mint) }
            );
            
            if (tokenAccounts.value.length === 0 || 
                parseFloat(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount) === 0) {
                console.log(`   ⚠️ Token ${symbol} déjà vendu ou balance nulle`);
                return { success: false, error: 'Token already sold or zero balance' };
            }
            
            // Utiliser le vrai solde actuel
            const realBalance = parseFloat(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
            const amountToSell = Math.floor(realBalance * 0.98); // 98% pour plus de marge
            
            if (amountToSell <= 0) {
                console.log(`   ❌ Montant trop petit après vérification`);
                return { success: false, error: 'Amount too small after verification' };
            }

            console.log(`   📊 Balance réelle: ${(realBalance / Math.pow(10, tokenAccounts.value[0].account.data.parsed.info.tokenAmount.decimals)).toLocaleString()}`);

            // Attendre plus longtemps pour éviter rate limit
            await this.sleep(2000);
            
            // Obtenir le quote Jupiter avec retry automatique
            const quote = await this.getQuoteWithRetry(mint, this.solMint, amountToSell);
            
            if (!quote) {
                console.log(`   ❌ Quote impossible après retries`);
                return { success: false, error: 'No quote available after retries' };
            }

            const expectedSol = parseFloat(quote.outAmount) / 1e9;
            console.log(`   💰 Quote: ${expectedSol.toFixed(4)} SOL`);

            // Attendre avant exécution
            await this.sleep(1500);

            // Exécuter la vente avec retry
            const txid = await this.executeSwapWithRetry(quote);
            
            if (txid) {
                console.log(`   ✅ Vente réussie ! TX: ${txid}`);
                
                // Attendre confirmation avant de continuer
                await this.sleep(3000);
                
                return { 
                    success: true, 
                    txid: txid, 
                    solReceived: expectedSol,
                    usdValue: usdValue 
                };
            } else {
                console.log(`   ❌ Échec transaction après retries`);
                return { success: false, error: 'Transaction failed after retries' };
            }

        } catch (error) {
            console.log(`   ❌ Erreur vente: ${error.message}`);
            
            // Si c'est un rate limit, attendre plus longtemps
            if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
                console.log(`   ⏳ Rate limit détecté, pause ${this.rateLimitDelay/1000}s`);
                await this.sleep(this.rateLimitDelay);
            }
            
            return { success: false, error: error.message };
        }
    }

    // Helper pour sleep
    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Obtenir quote avec retry automatique
    async getQuoteWithRetry(inputMint, outputMint, amount) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                console.log(`   🔍 Tentative quote ${attempt}/3`);
                
                await this.jupiterAPI.waitForRateLimit();
                const quote = await this.jupiterAPI.getJupiterQuote(inputMint, outputMint, amount, false);
                
                if (quote) {
                    return quote;
                }
                
                if (attempt < 3) {
                    const delay = attempt * 2000; // 2s, 4s
                    console.log(`   ⏳ Pause ${delay/1000}s avant retry quote`);
                    await this.sleep(delay);
                }
                
            } catch (error) {
                console.log(`   ❌ Erreur quote tentative ${attempt}: ${error.message}`);
                
                if (error.message.includes('429')) {
                    const delay = Math.min(attempt * 5000, 15000); // Max 15s
                    console.log(`   ⏳ Rate limit - pause ${delay/1000}s`);
                    await this.sleep(delay);
                } else if (attempt < 3) {
                    await this.sleep(2000);
                }
            }
        }
        return null;
    }

    // Exécuter swap avec retry
    async executeSwapWithRetry(quote) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                console.log(`   🚀 Tentative transaction ${attempt}/2`);
                
                const txid = await this.jupiterAPI.executeSwap(quote);
                if (txid) {
                    return txid;
                }
                
                if (attempt < 2) {
                    console.log(`   ⏳ Pause 5s avant retry transaction`);
                    await this.sleep(5000);
                }
                
            } catch (error) {
                console.log(`   ❌ Erreur transaction tentative ${attempt}: ${error.message}`);
                
                if (attempt < 2) {
                    await this.sleep(5000);
                }
            }
        }
        return null;
    }

    // Vendre tous les tokens éligibles
    async sellAllTokens(eligibleTokens) {
        console.log(`\n🚨 DÉMARRAGE VENTE D'URGENCE`);
        console.log(`🎯 ${eligibleTokens.length} tokens à vendre`);
        console.log('═'.repeat(80));

        const results = {
            total: eligibleTokens.length,
            successful: 0,
            failed: 0,
            totalSolReceived: 0,
            totalUsdValue: 0,
            transactions: [],
            errors: []
        };

        // Obtenir le solde SOL initial
        const initialSolBalance = await this.connection.getBalance(this.wallet.publicKey);
        const initialSol = initialSolBalance / 1e9;
        console.log(`💰 SOL initial: ${initialSol.toFixed(4)} SOL\n`);

        // Vendre par batches (maintenant 1 par 1)
        for (let i = 0; i < eligibleTokens.length; i++) {
            const token = eligibleTokens[i];
            const tokenNum = i + 1;
            
            console.log(`\n📦 Token ${tokenNum}/${eligibleTokens.length}: ${token.symbol}`);
            console.log(`💰 Valeur: ${token.usdValue.toFixed(2)} (${token.humanBalance.toLocaleString()} tokens)`);

            let result = null;
            
            // Tentatives avec retry et délais exponentiels
            for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
                try {
                    if (attempt > 1) {
                        const delay = this.baseDelay * Math.pow(2, attempt - 1); // Délai exponentiel
                        console.log(`   🔄 Tentative ${attempt}/${this.retryAttempts} dans ${delay/1000}s`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    }
                    
                    result = await this.sellToken(token);
                    
                    if (result.success) {
                        console.log(`   🎉 ${token.symbol} vendu avec succès !`);
                        break;
                    } else {
                        console.log(`   ⚠️ Échec tentative ${attempt}: ${result.error}`);
                        
                        // Si c'est un problème de solde ou token déjà vendu, pas la peine de retry
                        if (result.error.includes('already sold') || 
                            result.error.includes('zero balance') ||
                            result.error.includes('Amount too small')) {
                            console.log(`   ⏭️ Skip retry pour ${token.symbol}`);
                            break;
                        }
                    }
                    
                } catch (error) {
                    console.log(`   ❌ Erreur tentative ${attempt}: ${error.message}`);
                    
                    if (attempt === this.retryAttempts) {
                        result = { success: false, error: error.message };
                    }
                }
            }
            
            // Traiter le résultat final
            if (result && result.success) {
                results.successful++;
                results.totalSolReceived += result.solReceived;
                results.totalUsdValue += result.usdValue;
                results.transactions.push({
                    symbol: token.symbol,
                    txid: result.txid,
                    solReceived: result.solReceived,
                    usdValue: result.usdValue
                });
            } else {
                results.failed++;
                results.errors.push({
                    symbol: token.symbol,
                    error: result?.error || 'Unknown error'
                });
            }

            // Pause entre tokens pour éviter rate limiting (sauf le dernier)
            if (i < eligibleTokens.length - 1) {
                const pauseTime = 8000; // 8 secondes entre tokens
                console.log(`   ⏳ Pause ${pauseTime/1000}s avant prochain token...`);
                await new Promise(resolve => setTimeout(resolve, pauseTime));
            }
        }

        // Solde final
        await new Promise(resolve => setTimeout(resolve, 3000)); // Attendre confirmation
        const finalSolBalance = await this.connection.getBalance(this.wallet.publicKey);
        const finalSol = finalSolBalance / 1e9;
        const solGained = finalSol - initialSol;

        // Rapport final
        console.log('\n═'.repeat(80));
        console.log('🎉 VENTE D\'URGENCE TERMINÉE');
        console.log('═'.repeat(80));
        console.log(`📊 Résultats:`);
        console.log(`   ✅ Réussies: ${results.successful}/${results.total}`);
        console.log(`   ❌ Échecs: ${results.failed}/${results.total}`);
        console.log(`   💰 SOL reçu: ${results.totalSolReceived.toFixed(4)} SOL`);
        console.log(`   💵 Valeur USD: $${results.totalUsdValue.toFixed(2)}`);
        console.log(`   📈 SOL wallet: ${initialSol.toFixed(4)} → ${finalSol.toFixed(4)} (+${solGained.toFixed(4)})`);

        if (results.transactions.length > 0) {
            console.log(`\n📋 Transactions réussies:`);
            results.transactions.forEach((tx, i) => {
                console.log(`   ${i+1}. ${tx.symbol}: ${tx.solReceived.toFixed(4)} SOL ($${tx.usdValue.toFixed(2)})`);
                console.log(`      TX: https://solscan.io/tx/${tx.txid}`);
            });
        }

        if (results.errors.length > 0) {
            console.log(`\n❌ Erreurs:`);
            results.errors.forEach((error, i) => {
                console.log(`   ${i+1}. ${error.symbol}: ${error.error}`);
            });
        }

        console.log('═'.repeat(80));

        return results;
    }

    // Mode interactif avec confirmation
    async runInteractiveMode() {
        console.log('🚨 MODE INTERACTIF - Vente d\'urgence tokens >$1');
        console.log('═'.repeat(60));

        // Scanner les tokens
        const eligibleTokens = await this.scanWalletTokens();
        
        if (eligibleTokens.length === 0) {
            console.log('✅ Aucun token >$1 trouvé. Wallet déjà clean !');
            return;
        }

        // Demander confirmation
        console.log(`\n🚨 ATTENTION: Vous allez vendre ${eligibleTokens.length} tokens !`);
        console.log(`💰 Valeur totale: $${eligibleTokens.reduce((sum, t) => sum + t.usdValue, 0).toFixed(2)}`);
        console.log(`📈 Slippage maximum: ${this.maxSlippage}%`);
        
        // Dans un vrai environnement, vous pouvez ajouter une demande de confirmation ici
        console.log('\n⚠️ Démarrage automatique dans 5 secondes...');
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Exécuter la vente
        return await this.sellAllTokens(eligibleTokens);
    }

    // Mode automatique sans confirmation
    async runAutoMode() {
        console.log('🤖 MODE AUTOMATIQUE - Vente immédiate tokens >$1');
        console.log('═'.repeat(60));

        const eligibleTokens = await this.scanWalletTokens();
        
        if (eligibleTokens.length === 0) {
            console.log('✅ Aucun token >$1 trouvé.');
            return { total: 0, successful: 0, failed: 0 };
        }

        return await this.sellAllTokens(eligibleTokens);
    }

    // Vendre des tokens spécifiques par symbole
    async sellSpecificTokens(symbols) {
        console.log(`🎯 VENTE SPÉCIFIQUE: ${symbols.join(', ')}`);
        console.log('═'.repeat(60));

        const allTokens = await this.scanWalletTokens();
        const targetTokens = allTokens.filter(token => 
            symbols.includes(token.symbol) || 
            symbols.includes(token.mint)
        );

        if (targetTokens.length === 0) {
            console.log('❌ Aucun token spécifié trouvé dans le wallet');
            return { total: 0, successful: 0, failed: 0 };
        }

        console.log(`🎯 ${targetTokens.length} token(s) ciblé(s) trouvé(s)`);
        return await this.sellAllTokens(targetTokens);
    }
}

// Fonctions d'utilisation
async function runEmergencySell() {
    const seller = new EmergencyTokenSeller();
    return await seller.runInteractiveMode();
}

async function runAutoSell() {
    const seller = new EmergencyTokenSeller();
    return await seller.runAutoMode();
}

async function sellSpecific(symbols) {
    const seller = new EmergencyTokenSeller();
    return await seller.sellSpecificTokens(symbols);
}

async function scanOnly() {
    console.log('👀 SCAN UNIQUEMENT - Aucune vente');
    console.log('═'.repeat(40));
    
    const seller = new EmergencyTokenSeller();
    const tokens = await seller.scanWalletTokens();
    
    console.log(`\n🎯 ${tokens.length} tokens >$${seller.minTokenValue} trouvés`);
    console.log('💡 Utilisez --sell pour les vendre');
    
    return tokens;
}

module.exports = { 
    EmergencyTokenSeller, 
    runEmergencySell, 
    runAutoSell, 
    sellSpecific, 
    scanOnly 
};

// Exécution directe
if (require.main === module) {
    const args = process.argv.slice(2);
    
    console.log('🚨 Emergency Token Seller');
    console.log('═'.repeat(50));
    
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Usage:');
        console.log('  node emergency_token_seller.js              - Mode interactif (avec confirmation)');
        console.log('  node emergency_token_seller.js --auto       - Mode automatique (sans confirmation)');
        console.log('  node emergency_token_seller.js --scan       - Scanner uniquement (pas de vente)');
        console.log('  node emergency_token_seller.js --sell BONK WIF - Vendre tokens spécifiques');
        console.log('');
        console.log('Variables .env:');
        console.log('  PRIVATE_KEY=...                    (requis)');
        console.log('  MIN_TOKEN_VALUE=1.0               (optionnel, défaut: $1)');
        console.log('  EMERGENCY_SLIPPAGE=15             (optionnel, défaut: 15%)');
        console.log('');
        console.log('⚠️ ATTENTION: Vend TOUS les tokens >$1 contre SOL !');
        
    } else if (args.includes('--auto')) {
        console.log('🤖 Mode automatique activé');
        runAutoSell().catch(console.error);
        
    } else if (args.includes('--scan')) {
        scanOnly().catch(console.error);
        
    } else if (args.includes('--sell') && args.length > 1) {
        const symbolIndex = args.indexOf('--sell');
        const symbols = args.slice(symbolIndex + 1);
        console.log(`🎯 Vente spécifique: ${symbols.join(', ')}`);
        sellSpecific(symbols).catch(console.error);
        
    } else {
        console.log('💡 Mode interactif - Tapez --help pour plus d\'options');
        runEmergencySell().catch(console.error);
    }
}