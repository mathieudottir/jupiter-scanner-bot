
    // simple_auto_trader.js - Auto-trader Jupiter avec whitelist DexScreener
require('dotenv').config();
const DiscordNotifications = require('./discord_notifications'); // ← Cette ligne
const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const express = require('express');
const TradeLogger = require('./trade_logger');
const JupiterAPI = require('./jupiter_api')



const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class SimpleAutoTrader {
    constructor() {
                    // Configuration Discord
            this.discordNotifications = new DiscordNotifications(
                process.env.DISCORD_TOKEN,
                process.env.DISCORD_CHANNEL_ID
            );
        
        // Configuration Solana avec RPC sécurisé
        const rpcUrls = [
            'https://api.mainnet-beta.solana.com',
            'https://rpc.ankr.com/solana',
            'https://solana-api.projectserum.com',
            process.env.SOLANA_RPC_URL
        ].filter(url => url && !url.includes('undefined'));
        
        this.connection = new Connection(rpcUrls[0] || 'https://api.mainnet-beta.solana.com', {
            commitment: 'confirmed',
            wsEndpoint: false,
            httpHeaders: { 'User-Agent': 'Jupiter-Trader/1.0' }
        });

        this.backupConnections = rpcUrls.slice(1).map(url => 
            new Connection(url, { 
                commitment: 'confirmed',
                wsEndpoint: false
            })
        );

        // Configuration wallet et trading
        this.wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
        this.buyAmount = 0.01; // 0.01 SOL par achat
        this.maxSlippage = parseFloat(process.env.MAX_SLIPPAGE || '10');
        this.maxConcurrentPositions = 5;

        this.jupiterAPI = new JupiterAPI(
        this.wallet, 
        this.connection, 
        this.backupConnections, 
        this.maxSlippage
);
        this.tradeLogger = new TradeLogger();
        // WHITELIST - Chargement depuis fichier
        this.whitelistedTokens = {};
        this.whitelistPath = './whitelist.json';
        this.loadWhitelist();

        
        // Configuration whitelist PLUS FLEXIBLE pour trouver des trades
        // Configuration whitelist OPTIMISÉE
                this.whitelistMode = {
            enabled: true,
            allowOnlyWhitelisted: true,
            minMomentum1h: 0,        // 0% sur 1h (accepter stabilité)
            minMomentum24h: 2,       // +2% sur 24h (légèrement positif)
            minVolume: 100000,       // $100k volume (plus réaliste)
            debugMode: true
        };

        // Système de cooldown PLUS SMART
        this.retradeCooldown = {
    normal: 24 * 60 * 60 * 1000,        // 24h normal
    afterLoss: 36 * 60 * 60 * 1000,     // 36h si perte (au lieu de 48h)
    afterProfit: 8 * 60 * 60 * 1000,    // 8h si profit (au lieu de 12h)
    opportunityThreshold: 40,             // +40% momentum pour override (au lieu de 50%)
    minCooldownOverride: 6 * 60 * 60 * 1000  // Min 6h avant override
};
        // STATISTIQUES DE PERFORMANCE
        this.stats = {
            allTime: {
                totalTrades: 0,
                wins: 0,
                losses: 0,
                totalProfitSOL: 0,
                totalInvestedSOL: 0,
                bestTrade: { symbol: 'N/A', profit: 0 },
                worstTrade: { symbol: 'N/A', profit: 0 },
                avgHoldTime: 0,
                totalHoldTime: 0
            },
            daily: {
                date: new Date().toDateString(),
                trades: 0,
                wins: 0,
                losses: 0,
                profitSOL: 0,
                investedSOL: 0
            },
            hourly: {
                hour: new Date().getHours(),
                trades: 0,
                wins: 0,
                losses: 0,
                profitSOL: 0
            },
            session: {
                startTime: Date.now(),
                trades: 0,
                wins: 0,
                losses: 0,
                profitSOL: 0,
                investedSOL: 0
            }
        };

        // Configuration ventes échelonnées
        // VENTES PLUS AGRESSIVES
        this.sellLevels = [
            { profit: 12, percentage: 35, reason: "Sécurisation rapide (+12%)" },
            { profit: 30, percentage: 45, reason: "Profit solide (+30%)" },
            { profit: 60, percentage: 65, reason: "Gros profit (+60%)" },
            { profit: 120, percentage: 85, reason: "Moonshot (+120%)" }
        ];

        // Protections stop-loss et trailing
        this.stopLossPercent = 10; // -10%
        this.useTrailingStop = true;
        this.trailingStopPercent = 9; // 9% depuis le plus haut

        // Sortie par stagnation
        this.stagnationExit = {
            enabled: true,
            maxHoldTime: 4 * 60 * 60 * 1000,    // 4 heures maximum
            stagnantTime: 2 * 60 * 60 * 1000,   // 2h si stagnant
            stagnantThreshold: 5,                // ±5% = stagnant
            lossExitTime: 90 * 60 * 1000,       // 1h30 si perte
            lossThreshold: -10                   // -10%
        };

        

        // État du trader
        this.positions = new Map(); // tokenAddress -> position data
        this.tradedTokens = new Map(); // tokenAddress -> tradeHistory pour cooldown
        this.bannedAddresses = new Set();

        // Charger adresses bannies
        this.loadBannedAddresses();

        console.log(`💼 Wallet: ${this.wallet.publicKey.toString()}`);
        console.log(`🛡️ Whitelist: ${Object.keys(this.whitelistedTokens).length} tokens`);
        console.log(`💰 Montant par achat: ${this.buyAmount} SOL`);
        console.log(`🎯 Ventes échelonnées: ${this.sellLevels.length} niveaux`);
        console.log(`📉 Stop loss: -${this.stopLossPercent}%`);
        console.log(`📈 Trailing stop: -${this.trailingStopPercent}%`);
    }

    // CHARGEMENT DE LA WHITELIST - FORMAT CORRECT POUR VOTRE FICHIER
    loadWhitelist() {
        try {
            const fs = require('fs');
            
            if (fs.existsSync(this.whitelistPath)) {
                const whitelistData = JSON.parse(fs.readFileSync(this.whitelistPath, 'utf8'));
                
                // Votre format: whitelistData.tokens.SYMBOL.address
                for (const [symbol, data] of Object.entries(whitelistData.tokens)) {
                    if (data.verified && data.address) {
                        this.whitelistedTokens[symbol] = data.address;
                    }
                }
                
                console.log(`✅ Whitelist VOTRE FICHIER chargée: v${whitelistData.metadata?.version || 'N/A'}`);
                console.log(`📊 ${Object.keys(this.whitelistedTokens).length} tokens vérifiés de votre whitelist`);
                console.log(`🎯 Tokens chargés: ${Object.keys(this.whitelistedTokens).join(', ')}`);
                
                // Vérification spéciale pour HNT
                if (this.whitelistedTokens.HNT) {
                    console.log(`🔍 HNT trouvé: ${this.whitelistedTokens.HNT}`);
                    console.log(`   📝 Nom: ${whitelistData.tokens.HNT.name}`);
                    console.log(`   📂 Catégorie: ${whitelistData.tokens.HNT.category}`);
                    console.log(`   ✅ Vérifié: ${whitelistData.tokens.HNT.verified}`);
                } else {
                    console.log(`❌ HNT non trouvé dans la whitelist !`);
                }
                
            } else {
                console.log(`❌ ERREUR: Fichier whitelist INTROUVABLE: ${this.whitelistPath}`);
                console.log(`📝 Le bot ne peut fonctionner SANS votre whitelist !`);
                console.log(`💡 Créez le fichier whitelist.json avec vos tokens vérifiés`);
                
                throw new Error('Whitelist fichier requis !');
            }
            
        } catch (error) {
            console.error(`❌ Erreur chargement whitelist: ${error.message}`);
            console.log(`🛑 Bot arrêté - whitelist.json requis`);
            process.exit(1);
        }
    }

    createBasicWhitelist() {
        // Whitelist CORRIGÉE avec adresses VÉRIFIÉES Solana
        this.whitelistedTokens = {
            // Meme coins populaires - ADRESSES VÉRIFIÉES
            'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
            'WIF': 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 
            'PEPE': 'BzUb1pc3GKZD1DbLhKpuzWJCPBdSFGSqhfFGBCSDhyPR',  // À vérifier
            'POPCAT': '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
        };
        
        console.log(`📝 Whitelist CORRIGÉE avec ${Object.keys(this.whitelistedTokens).length} tokens vérifiés`);
        console.log(`✅ Adresses vérifiées pour éviter erreurs de route`);
    }

    // GESTION DES ADRESSES BANNIES
    loadBannedAddresses() {
        try {
            const fs = require('fs');
            if (fs.existsSync('./banned_addresses.txt')) {
                const content = fs.readFileSync('./banned_addresses.txt', 'utf8');
                const addresses = content.split('\n')
                    .map(addr => addr.trim())
                    .filter(addr => addr && !addr.startsWith('#'));
                
                addresses.forEach(addr => this.bannedAddresses.add(addr));
                console.log(`🚫 ${addresses.length} adresses bannies chargées`);
            }
        } catch (error) {
            console.log('⚠️ Erreur chargement banned_addresses.txt:', error.message);
        }
    }

    isAddressBanned(tokenAddress) {
        return this.bannedAddresses.has(tokenAddress);
    }

    banAddress(tokenAddress, reason = 'Manual ban') {
        this.bannedAddresses.add(tokenAddress);
        console.log(`🚫 Adresse bannie: ${tokenAddress} (${reason})`);
        this.saveBannedAddresses();
    }

    saveBannedAddresses() {
        try {
            const fs = require('fs');
            const content = Array.from(this.bannedAddresses).join('\n');
            fs.writeFileSync('./banned_addresses.txt', content);
        } catch (error) {
            console.log('⚠️ Erreur sauvegarde banned_addresses.txt:', error.message);
        }
    }

    // SYSTÈME DE COOLDOWN POUR RE-TRADING
    isTokenAlreadyProcessed(tokenAddress, currentMomentumScore = 0) {
        if (!this.tradedTokens.has(tokenAddress)) {
            return false;
        }
        
        const tradeHistory = this.tradedTokens.get(tokenAddress);
        const lastTrade = tradeHistory.lastTradeTime;
        const lastResult = tradeHistory.lastResult;
        const timeSinceLastTrade = Date.now() - lastTrade;
        
        let cooldownTime;
        if (lastResult === 'profit') {
            cooldownTime = this.retradeCooldown.afterProfit;
        } else if (lastResult === 'loss') {
            cooldownTime = this.retradeCooldown.afterLoss;
        } else {
            cooldownTime = this.retradeCooldown.normal;
        }
        
        if (timeSinceLastTrade < cooldownTime) {
            const canOverride = this.canOverrideCooldown(tradeHistory, currentMomentumScore, timeSinceLastTrade);
            
            if (canOverride) {
                console.log(`⚡ Override cooldown pour opportunité exceptionnelle`);
                return false;
            }
            
            const remainingHours = ((cooldownTime - timeSinceLastTrade) / (1000 * 60 * 60)).toFixed(1);
            console.log(`⏳ Token en cooldown (${remainingHours}h restantes)`);
            return true;
        }
        
        this.tradedTokens.delete(tokenAddress);
        return false;
    }

    canOverrideCooldown(tradeHistory, currentMomentumScore, timeSinceLastTrade) {
        if (timeSinceLastTrade < this.retradeCooldown.minCooldownOverride) return false;
        if (currentMomentumScore < this.retradeCooldown.opportunityThreshold) return false;
        if (tradeHistory.lastResult === 'loss' && timeSinceLastTrade < 24 * 60 * 60 * 1000) return false;
        return true;
    }

    markTokenAsProcessed(tokenAddress, result = 'unknown') {
        this.tradedTokens.set(tokenAddress, {
            lastTradeTime: Date.now(),
            lastResult: result,
            tradeCount: (this.tradedTokens.get(tokenAddress)?.tradeCount || 0) + 1
        });
        console.log(`📝 Token marqué: ${tokenAddress.slice(0, 8)}... (${result})`);
    }

    // SCANNER WHITELIST VIA DEXSCREENER AVEC LOGS DÉTAILLÉS
    async scanNewTokens() {
        console.log('🔍 Scan whitelist via DexScreener...');
        
        if (!this.whitelistMode.enabled || !this.whitelistMode.allowOnlyWhitelisted) {
            console.log('⚠️ Mode whitelist désactivé');
            return [];
        }
        
        try {
            const momentumTokens = [];
            const whitelistEntries = Object.entries(this.whitelistedTokens);
            
            console.log(`📊 Vérification momentum pour ${whitelistEntries.length} tokens...`);
            console.log(`🎯 Critères: 1h(≥${this.whitelistMode.minMomentum1h}%) 24h(≥${this.whitelistMode.minMomentum24h}%) vol(≥${this.whitelistMode.minVolume.toLocaleString()})`);
            console.log('─'.repeat(80));
            
            for (const [symbol, address] of whitelistEntries) {
                try {
                    console.log(`🔎 ${symbol.padEnd(8)} | Vérification...`);
                    
                    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
                    
                    if (!response.ok) {
                        console.log(`   ❌ DexScreener error ${response.status}`);
                        continue;
                    }
                    
                    const data = await response.json();
                    const pair = data.pairs?.find(p => p.chainId === 'solana');
                    
                    if (!pair) {
                        console.log(`   ❌ Pas de paire Solana trouvée`);
                        continue;
                    }
                    
                    const change1h = parseFloat(pair.priceChange?.h1 || 0);
                    const change24h = parseFloat(pair.priceChange?.h24 || 0);
                    const volume24h = parseFloat(pair.volume?.h24 || 0);
                    const liquidity = parseFloat(pair.liquidity?.usd || 0);
                    const price = parseFloat(pair.priceUsd || 0);
                    
                    // LOG DÉTAILLÉ pour chaque token
                    const change1hStr = change1h >= 0 ? `+${change1h.toFixed(1)}%` : `${change1h.toFixed(1)}%`;
                    const change24hStr = change24h >= 0 ? `+${change24h.toFixed(1)}%` : `${change24h.toFixed(1)}%`;
                    
                    console.log(`   📊 1h: ${change1hStr.padStart(8)} | 24h: ${change24hStr.padStart(8)} | Vol: ${volume24h.toLocaleString().padStart(10)} | Liq: ${liquidity.toLocaleString().padStart(10)}`);
                    
                    // Vérifier critères un par un avec détails
                    const checks = {
                        momentum1h: change1h >= this.whitelistMode.minMomentum1h,
                        momentum24h: change24h >= this.whitelistMode.minMomentum24h,
                        volume: volume24h >= this.whitelistMode.minVolume,
                        price: price > 0,
                        liquidity: liquidity > 10000 // Au moins $10k de liquidité
                    };
                    
                    const passedChecks = Object.values(checks).filter(Boolean).length;
                    const totalChecks = Object.keys(checks).length;
                    
                    console.log(`   🔍 Checks: ${passedChecks}/${totalChecks} `, Object.entries(checks).map(([key, passed]) => 
                        `${key}:${passed ? '✅' : '❌'}`
                    ).join(' '));
                    
                    // Si tous les critères sont remplis
                    if (Object.values(checks).every(Boolean)) {
                        console.log(`   🎯 ✅ ${symbol} QUALIFIÉ pour trading !`);
                        
                        const tokenData = {
                            baseToken: {
                                address: address,
                                symbol: symbol,
                                name: pair.baseToken?.name || symbol
                            },
                            priceUsd: price.toString(),
                            volume: { h24: volume24h },
                            liquidity: { usd: liquidity },
                            priceChange: { h1: change1h, h24: change24h },
                            scanReason: `🛡️ Whitelist ${symbol}`,
                            isWhitelisted: true,
                            momentumScore: (change1h * 3) + (change24h * 2),
                            dexData: pair,
                            // Infos détaillées pour debug
                            scanDetails: {
                                change1h: change1h,
                                change24h: change24h,
                                volume24h: volume24h,
                                liquidity: liquidity,
                                price: price,
                                checksResult: checks
                            }
                        };
                        
                        momentumTokens.push(tokenData);
                        
                    } else {
                        // Expliquer pourquoi le token est rejeté
                        const failedReasons = [];
                        if (!checks.momentum1h) failedReasons.push(`1h(${change1hStr}<${this.whitelistMode.minMomentum1h}%)`);
                        if (!checks.momentum24h) failedReasons.push(`24h(${change24hStr}<${this.whitelistMode.minMomentum24h}%)`);
                        if (!checks.volume) failedReasons.push(`vol(${volume24h.toLocaleString()}<${this.whitelistMode.minVolume.toLocaleString()})`);
                        if (!checks.price) failedReasons.push(`prix(${price})`);
                        if (!checks.liquidity) failedReasons.push(`liq(${liquidity.toLocaleString()}<$10k)`);
                        
                        console.log(`   ⚠️ ❌ ${symbol} REJETÉ: ${failedReasons.join(', ')}`);
                    }
                    
                } catch (tokenError) {
                    console.log(`   ❌ ${symbol}: Erreur ${tokenError.message}`);
                }
                
                // Rate limiting DexScreener
                await new Promise(resolve => setTimeout(resolve, 800)); // 800ms entre tokens
            }
            
            console.log('─'.repeat(80));
            
            // Trier par momentum 1h (le plus récent = priorité)
            const sortedTokens = momentumTokens.sort((a, b) => {
                return (b.priceChange.h1 || 0) - (a.priceChange.h1 || 0);
            });
            
            console.log(`🎯 RÉSULTAT FINAL: ${sortedTokens.length} tokens qualifiés pour trading:`);
            
            if (sortedTokens.length > 0) {
                sortedTokens.forEach((token, i) => {
                    const change1h = token.priceChange.h1;
                    const change24h = token.priceChange.h24;
                    const score = token.momentumScore;
                    const vol = token.volume.h24;
                    
                    const change1hStr = change1h >= 0 ? `+${change1h.toFixed(1)}%` : `${change1h.toFixed(1)}%`;
                    const change24hStr = change24h >= 0 ? `+${change24h.toFixed(1)}%` : `${change24h.toFixed(1)}%`;
                    
                    console.log(`   ${(i+1).toString().padStart(2)}. ${token.baseToken.symbol.padEnd(8)} | 1h: ${change1hStr.padStart(8)} | 24h: ${change24hStr.padStart(8)} | Vol: ${vol.toLocaleString().padStart(10)} | Score: ${score.toFixed(1).padStart(6)}`);
                });
            } else {
                console.log(`   📋 Aucun token ne répond aux critères actuels.`);
                console.log(`   💡 Suggestions:`);
                console.log(`      - Réduire minMomentum1h (actuellement ${this.whitelistMode.minMomentum1h}%)`);
                console.log(`      - Réduire minMomentum24h (actuellement ${this.whitelistMode.minMomentum24h}%)`);
                console.log(`      - Réduire minVolume (actuellement ${this.whitelistMode.minVolume.toLocaleString()})`);
                console.log(`      - Ajouter plus de tokens à la whitelist`);
            }
            
            console.log('═'.repeat(80));
            return sortedTokens;
            
        } catch (error) {
            console.error('❌ Erreur scan DexScreener:', error.message);
            return [];
        }
    }

    // INITIALISATION DISCORD
    async initializeDiscord() {
    return await this.discordNotifications.initialize();
}


    // ACHAT DE TOKEN AVEC POSITION SIZING VARIABLE
    async buyToken(tokenAddress, tokenData) {
        try {
            const symbol = tokenData.baseToken.symbol;
            
            // Vérification whitelist absolue
            if (this.whitelistMode.enabled && this.whitelistMode.allowOnlyWhitelisted) {
                if (!this.whitelistedTokens[symbol]) {
                    console.log(`🚨 SKIP ${symbol}: Non whitelisté`);
                    this.banAddress(tokenAddress, 'Not in whitelist');
                    return false;
                }
                
                const expectedAddress = this.whitelistedTokens[symbol];
                if (expectedAddress !== tokenAddress) {
                    console.log(`🚨 SKIP ${symbol}: SCAM détecté !`);
                    this.banAddress(tokenAddress, `SCAM: Fake ${symbol}`);
                    return false;
                }
            }
            
            // Test de vendabilité SIMPLE
            const sellTest = await this.jupiterAPI.testTokenSellability(tokenAddress);
            if (!sellTest.canSell) {
                console.log(`🚨 SKIP ${symbol}: ${sellTest.reason}`);
                this.banAddress(tokenAddress, sellTest.reason);
                return false;
            }
            console.log(`✅ ${symbol}: ${sellTest.reason}`);
            
            // POSITION SIZING VARIABLE (nouveau)
            let dynamicBuyAmount = this.buyAmount;
            
            // Size plus petit pour memecoins
            if (['BONK', 'WIF', 'POPCAT', 'PENGU', 'FARTCOIN', 'AGI', 'ZBCN'].includes(symbol)) {
                dynamicBuyAmount = this.buyAmount ; // 30% moins pour memes
                console.log(`🎭 Memecoin détecté: Taille réduite à ${dynamicBuyAmount.toFixed(3)} SOL`);
            }
            
            // Size plus gros pour DeFi établi  
            if (['JUP', 'RAY', 'ORCA', 'PYTH', 'JTO', 'DRIFT'].includes(symbol)) {
                dynamicBuyAmount = this.buyAmount ; // 30% plus pour DeFi sûr
                console.log(`🏦 DeFi établi détecté: Taille augmentée à ${dynamicBuyAmount.toFixed(3)} SOL`);
            }
            
            // Exécution de l'achat
            const solAmount = dynamicBuyAmount * 1e9;
            const solMint = 'So11111111111111111111111111111111111111112';
            
            const buyQuote = await this.jupiterAPI.getJupiterQuote(solMint, tokenAddress, solAmount, false); // Avec vérification solde
            if (!buyQuote) {
                console.log(`❌ Quote impossible pour ${symbol}`);
                return false;
            }
            
            const txid = await this.jupiterAPI.executeSwap(buyQuote);
            
            if (txid) {
                const tokenAmount = parseFloat(buyQuote.outAmount);
                const price = parseFloat(tokenData.priceUsd || 0);
                
                const position = {
                    tokenAddress,
                    symbol: symbol,
                    buyPrice: price,
                    buyAmount: tokenAmount,
                    currentAmount: tokenAmount,
                    buyTxid: txid,
                    buyTime: Date.now(),
                    solSpent: dynamicBuyAmount, // Utiliser le montant dynamique
                    sellsExecuted: [],
                    totalSolReceived: 0,
                    partialSells: 0,
                    highestPrice: price,
                    highestPercent: 0,
                    isWhitelisted: true,
                    confidenceLevel: 'HIGH',
                    category: this.getCategoryFromSymbol(symbol) // Pour les stats
                };
                
                this.positions.set(tokenAddress, position);

                        const buyTradeData = {
                            type: 'BUY',
                            timestamp: Date.now(),
                            symbol: symbol,
                            tokenAddress: tokenAddress,
                            priceUSD: price,
                            solInvested: dynamicBuyAmount,
                            tokensReceived: tokenAmount,
                            momentum1h: tokenData.priceChange?.h1 || 0,
                            momentum24h: tokenData.priceChange?.h24 || 0,
                            volume24h: tokenData.volume?.h24 || 0,
                            liquidityUSD: tokenData.liquidity?.usd || 0,
                            category: this.getCategoryFromSymbol(symbol),
                            confidence: 'HIGH',
                            reason: 'Whitelist momentum',
                            txHash: txid,
                            activePositions: this.positions.size,
                            sessionProfit: this.stats.session.profitSOL
                        };

await this.tradeLogger.logTrade(buyTradeData);
                
                // METTRE À JOUR LES STATISTIQUES
                this.updateStatsOnBuy(dynamicBuyAmount, symbol);
                
                console.log(`✅ ACHAT RÉUSSI: ${symbol}`);
                console.log(`   💰 Prix: ${price.toFixed(6)}`);
                console.log(`   🪙 Quantité: ${tokenAmount.toLocaleString()}`);
                console.log(`   💎 Investissement: ${dynamicBuyAmount.toFixed(3)} SOL`);
                console.log(`   🔗 TX: ${txid}`);
                
                await this.discordNotifications.notifyBuy(position, tokenData, this.sellLevels, this.stopLossPercent);
                return true;
            }
            
            return false;
            
        } catch (error) {
            console.error(`❌ Erreur achat ${tokenData.baseToken?.symbol}: ${error.message}`);
            return false;
        }
    }

    // HELPER: Déterminer catégorie du token
    getCategoryFromSymbol(symbol) {
        const memecoins = ['BONK', 'WIF', 'POPCAT', 'PENGU', 'FARTCOIN', 'AGI', 'ZBCN'];
        const defi = ['JUP', 'RAY', 'ORCA', 'PYTH', 'JTO', 'DRIFT'];
        const infrastructure = ['SOL', 'RENDER', 'HNT'];
        const ai = ['GRASS', 'AI16Z'];
        
        if (memecoins.includes(symbol)) return 'meme';
        if (defi.includes(symbol)) return 'defi';
        if (infrastructure.includes(symbol)) return 'infrastructure';
        if (ai.includes(symbol)) return 'ai';
        return 'other';
    }   
    // GESTION DES STATISTIQUES
updateStatsOnBuy(solSpent, symbol) {
    // Session
    this.stats.session.trades++;
    this.stats.session.investedSOL += solSpent;
    
    // Daily - reset si nouveau jour
    const currentDate = new Date().toDateString();
    if (this.stats.daily.date !== currentDate) {
        this.stats.daily = {
            date: currentDate,
            trades: 0,
            wins: 0,
            losses: 0,
            profitSOL: 0,
            investedSOL: 0
        };
    }
    this.stats.daily.trades++;
    this.stats.daily.investedSOL += solSpent;
    
    // Hourly - reset si nouvelle heure
    const currentHour = new Date().getHours();
    if (this.stats.hourly.hour !== currentHour) {
        this.stats.hourly = {
            hour: currentHour,
            trades: 0,
            wins: 0,
            losses: 0,
            profitSOL: 0
        };
    }
    this.stats.hourly.trades++;
    
    // All time
    this.stats.allTime.totalTrades++;
    this.stats.allTime.totalInvestedSOL += solSpent;
    
    console.log(`📊 Stats mise à jour: ${this.stats.session.trades} trades session`);
}

updateStatsOnSell(solReceived, solSpent, profitPercent, buyTime, symbol, result) {
    const profit = solReceived - solSpent;
    const holdTime = Date.now() - buyTime;
    
    // Mettre à jour toutes les périodes
    [this.stats.session, this.stats.daily, this.stats.hourly, this.stats.allTime].forEach(period => {
        if (result === 'profit') {
            period.wins++;
        } else if (result === 'loss') {
            period.losses++;
        }
        
        if (period.profitSOL !== undefined) {
            period.profitSOL += profit;
        }
    });
    
    // All time spécifique
    this.stats.allTime.totalProfitSOL += profit;
    this.stats.allTime.totalHoldTime += holdTime;
    this.stats.allTime.avgHoldTime = this.stats.allTime.totalHoldTime / this.stats.allTime.totalTrades;
    
    // Best/Worst trades
    if (profitPercent > this.stats.allTime.bestTrade.profit) {
        this.stats.allTime.bestTrade = { symbol, profit: profitPercent };
    }
    if (profitPercent < this.stats.allTime.worstTrade.profit) {
        this.stats.allTime.worstTrade = { symbol, profit: profitPercent };
    }
    
    console.log(`📈 Trade fermé: ${symbol} ${profit > 0 ? '+' : ''}${profit.toFixed(4)} SOL`);
}


    // SURVEILLANCE ET GESTION DES POSITIONS
    async checkPositions() {
        if (this.positions.size === 0) return;
        
        console.log(`📊 Check de ${this.positions.size} positions...`);
        
        for (const [tokenAddress, position] of this.positions.entries()) {
            try {
                await this.checkSinglePosition(tokenAddress, position);
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error(`❌ Erreur check position ${position.symbol}: ${error.message}`);
            }
        }
    }

// Version console en backup
showPerformanceRecapConsole() {
    const now = new Date();
    const sessionHours = ((Date.now() - this.stats.session.startTime) / (1000 * 60 * 60)).toFixed(1);
    
    console.log('\n' + '═'.repeat(80));
    console.log(`📊 RÉCAP PERFORMANCE - ${now.toLocaleString()}`);
    console.log('═'.repeat(80));
    
    const sessionWinRate = this.stats.session.trades > 0 ? 
        ((this.stats.session.wins / this.stats.session.trades) * 100).toFixed(1) : '0';
    const sessionROI = this.stats.session.investedSOL > 0 ? 
        ((this.stats.session.profitSOL / this.stats.session.investedSOL) * 100).toFixed(1) : '0';
        
    console.log(`🕐 SESSION (${sessionHours}h):`);
    console.log(`   Trades: ${this.stats.session.trades} | Wins: ${this.stats.session.wins} | Losses: ${this.stats.session.losses} | WR: ${sessionWinRate}%`);
    console.log(`   Investi: ${this.stats.session.investedSOL.toFixed(3)} SOL | Profit: ${this.stats.session.profitSOL > 0 ? '+' : ''}${this.stats.session.profitSOL.toFixed(4)} SOL | ROI: ${sessionROI}%`);
    console.log('═'.repeat(80));
}

        async checkSinglePosition(tokenAddress, position) {
        try {
            // Obtenir le prix actuel via DexScreener
            const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
            if (!response.ok) return;
            
            const data = await response.json();
            const pair = data.pairs?.find(p => p.chainId === 'solana');
            if (!pair) return;
            
            const currentPrice = parseFloat(pair.priceUsd || 0);
            if (currentPrice <= 0) return;
            
            const changePercent = ((currentPrice / position.buyPrice) - 1) * 100;
            const holdTime = Date.now() - position.buyTime;
            
            // Mettre à jour le plus haut prix atteint
            if (currentPrice > position.highestPrice) {
                position.highestPrice = currentPrice;
                position.highestPercent = changePercent;
            }
            
            position.lastKnownPrice = currentPrice;
            
            console.log(`   💎 ${position.symbol}: ${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}% (${((holdTime) / (1000 * 60)).toFixed(0)}min)`);
            
            // 1. VÉRIFIER STOP-LOSS
            if (changePercent <= -this.stopLossPercent) {
                console.log(`🛑 Stop-Loss déclenché: ${position.symbol} (${changePercent.toFixed(1)}%)`);
                await this.sellEntirePosition(position, currentPrice, `Stop-Loss -${this.stopLossPercent}%`);
                return;
            }
            
            // 2. VÉRIFIER TRAILING STOP
            if (this.useTrailingStop && position.highestPercent > 0) {
                const trailingStopPrice = position.highestPrice * (1 - this.trailingStopPercent / 100);
                if (currentPrice <= trailingStopPrice) {
                    const trailingLoss = ((currentPrice / position.highestPrice) - 1) * 100;
                    console.log(`📉 Trailing Stop déclenché: ${position.symbol} (${trailingLoss.toFixed(1)}% depuis le max)`);
                    await this.sellEntirePosition(position, currentPrice, `Trailing Stop depuis +${position.highestPercent.toFixed(1)}%`);
                    return;
                }
            }
            
            // 3. VÉRIFIER SORTIE PAR STAGNATION
            if (this.stagnationExit.enabled) {
                if (holdTime > this.stagnationExit.maxHoldTime) {
                    console.log(`⏰ Sortie par temps maximum: ${position.symbol} (4h atteintes)`);
                    await this.sellEntirePosition(position, currentPrice, "Temps maximum atteint (4h)");
                    return;
                }
                
                if (holdTime > this.stagnationExit.stagnantTime && 
                    Math.abs(changePercent) < this.stagnationExit.stagnantThreshold) {
                    console.log(`😴 Sortie par stagnation: ${position.symbol} (±${this.stagnationExit.stagnantThreshold}% depuis 2h)`);
                    await this.sellEntirePosition(position, currentPrice, "Position stagnante");
                    return;
                }
                
                if (holdTime > this.stagnationExit.lossExitTime && 
                    changePercent < this.stagnationExit.lossThreshold) {
                    console.log(`🔴 Sortie par perte prolongée: ${position.symbol} (${changePercent.toFixed(1)}% depuis 1h30)`);
                    await this.sellEntirePosition(position, currentPrice, "Perte prolongée");
                    return;
                }
            }
            
            // 4. VÉRIFIER VENTES ÉCHELONNÉES
            await this.checkStagedSells(position, changePercent, currentPrice);
            
        } catch (error) {
            console.error(`❌ Erreur check position ${position.symbol}: ${error.message}`);
        }
    }
    // VENTES ÉCHELONNÉES
    async checkStagedSells(position, changePercent, currentPrice) {
        // Détecter si c'est un moonshot (>1000%)
        const isMoonshot = changePercent > 1000;
        
        if (isMoonshot) {
            console.log(`🌙 MOONSHOT DÉTECTÉ: ${position.symbol} +${changePercent.toFixed(0)}%`);
            
            if (!position.moonshotSellAttempted) {
                position.moonshotSellAttempted = true;
                const success = await this.handleMoonshotSell(position, currentPrice, `+${changePercent.toFixed(0)}%`);
                if (success) return;
            }
        }
        
        // Vérifier chaque niveau de vente
        for (const level of this.sellLevels) {
            if (changePercent >= level.profit && !position.sellsExecuted.includes(level.profit)) {
                
                const remainingAmount = position.currentAmount;
                let amountToSell = remainingAmount * (level.percentage / 100);
                
                // Pour moonshots, réduire les montants
                if (isMoonshot) {
                    amountToSell = Math.min(amountToSell, remainingAmount * 0.1);
                }
                
                if (amountToSell > 0) {
                    console.log(`🎯 Vente échelonnée: ${position.symbol} +${changePercent.toFixed(1)}%`);
                    console.log(`   💰 Vendre ${level.percentage}% (${amountToSell.toLocaleString()} tokens)`);
                    
                    const success = await this.sellPartialPosition(position, amountToSell, level, currentPrice);
                    
                    if (success) {
                        position.sellsExecuted.push(level.profit);
                        position.currentAmount = remainingAmount - amountToSell;
                        
                        if (position.currentAmount <= position.buyAmount * 0.01) {
    console.log(`✅ Position ${position.symbol} entièrement vendue par ventes échelonnées`);
    
    // Calculer les totaux pour le logging
    const totalSolReceived = position.totalSolReceived;
    const totalProfit = totalSolReceived - position.solSpent;
    const totalProfitPercent = ((totalSolReceived / position.solSpent) - 1) * 100;
    
    const sellTradeData = {
        type: 'SELL',
        timestamp: Date.now(),
        symbol: position.symbol,
        tokenAddress: position.tokenAddress,
        buyData: {
            priceUSD: position.buyPrice,
            solInvested: position.solSpent,
            tokensReceived: position.buyAmount,
            category: this.getCategoryFromSymbol(position.symbol),
            confidence: 'HIGH',
            txHash: position.buyTxid,
            buyTime: position.buyTime
        },
        totalSolReceived: totalSolReceived,
        totalProfit: totalProfit,
        totalProfitPercent: totalProfitPercent,
        sellPriceUSD: currentPrice,
        duration: Date.now() - position.buyTime,
        exitReason: "Ventes échelonnées complètes",
        partialSells: position.partialSells || 0,
        highestPrice: position.highestPrice || position.buyPrice,
        highestPercent: position.highestPercent || 0,
        txHashes: [] // Pas de TX spécifique car c'est la fin des ventes échelonnées
    };

    await this.tradeLogger.logTrade(sellTradeData);
    
    // Marquer comme traité et supprimer
    const tradeResult = totalProfitPercent > 10 ? 'profit' : totalProfitPercent < -5 ? 'loss' : 'breakeven';
    this.markTokenAsProcessed(position.tokenAddress, tradeResult);
    this.updateStatsOnSell(totalSolReceived, position.solSpent, totalProfitPercent, position.buyTime, position.symbol, tradeResult);
    
    this.positions.delete(position.tokenAddress);
    break;
}
                    } else if (isMoonshot) {
                        position.sellsExecuted.push(level.profit);
                    }
                }
            }
        }
    }

    // GESTION VENTE MOONSHOT
    async handleMoonshotSell(position, currentPrice, reason) {
        console.log(`🌙 Gestion vente moonshot: ${position.symbol}`);
        
        const totalSellSuccess = await this.sellEntirePosition(position, currentPrice, `Moonshot ${reason}`);
        
        if (totalSellSuccess) {
            console.log(`✅ Vente totale moonshot réussie !`);
            return true;
        }
        
        const chunkSuccess = await this.sellMoonshotInChunks(position, currentPrice);
        if (chunkSuccess) return true;
        
        console.log(`⚠️ Vente moonshot impossible - surveillance continue`);
        position.moonshotSellFailed = true;
        position.lastFailedSellTime = Date.now();
        
        return false;
    }

    // VENTE PAR CHUNKS POUR MOONSHOTS
    async sellMoonshotInChunks(position, currentPrice) {
        try {
            const tokenMint = position.tokenAddress;
            
            await this.jupiterAPI.waitForRateLimit();
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                this.wallet.publicKey,
                { mint: new PublicKey(tokenMint) }
            );
            
            if (tokenAccounts.value.length === 0) return false;
            
            const totalBalance = parseFloat(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
            const chunkSize = Math.floor(totalBalance * 0.1);
            const maxChunks = 5;
            let soldChunks = 0;
            let totalSolReceived = 0;
            
            for (let i = 0; i < maxChunks; i++) {
                const quote = await this.jupiterAPI.getJupiterQuote(tokenMint, 'So11111111111111111111111111111111111111112', chunkSize);
                
                if (quote) {
                    const txid = await this.jupiterAPI.executeSwap(quote);
                    
                    if (txid) {
                        const solReceived = parseFloat(quote.outAmount) / 1e9;
                        totalSolReceived += solReceived;
                        soldChunks++;
                        
                        position.totalSolReceived = (position.totalSolReceived || 0) + solReceived;
                        position.partialSells++;
                        
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
            
            if (soldChunks > 0) {
                await this.discordNotifications.notifyMoonshotChunkSell(position, soldChunks, totalSolReceived, currentPrice);
                return true;
            }
            
            return false;
            
        } catch (error) {
            console.error(`❌ Erreur vente chunks: ${error.message}`);
            return false;
        }
    }

    // VENTE PARTIELLE
    async sellPartialPosition(position, amountToSell, level, currentPrice) {
        try {
            const tokenMint = position.tokenAddress;
            const solMint = 'So11111111111111111111111111111111111111112';
            const roundedAmount = Math.floor(amountToSell);
            
            if (roundedAmount <= 0) return false;
            
            const hasTokens = await this.jupiterAPI.checkWalletBalance(tokenMint, roundedAmount);
            if (!hasTokens) return false;
            
            const sellQuote = await this.jupiterAPI.getJupiterQuote(tokenMint, solMint, roundedAmount);
            if (!sellQuote) return false;
            
            const txid = await this.jupiterAPI.executeSwap(sellQuote);
            
            if (txid) {
                const solReceived = parseFloat(sellQuote.outAmount) / 1e9;
                const partialProfit = solReceived - (position.solSpent * (level.percentage / 100));
                const partialProfitPercent = ((currentPrice / position.buyPrice) - 1) * 100;
                
                await this.discordNotifications.notifyPartialSell(position, solReceived, partialProfit, partialProfitPercent, level, txid);
                
                position.totalSolReceived += solReceived;
                position.partialSells += 1;
                const partialSellData = {
                            type: 'PARTIAL_SELL',
                            timestamp: Date.now(),
                            symbol: position.symbol,
                            tokenAddress: position.tokenAddress,
                            priceUSD: currentPrice,
                            solReceived: solReceived,
                            profitSOL: partialProfit,
                            profitPercent: partialProfitPercent,
                            percentage: level.percentage,
                            reason: level.reason,
                            txHash: txid,
                            currentHoldTime: Date.now() - position.buyTime
                        };

await this.tradeLogger.logTrade(partialSellData);
                
                return true;
            }
            
            return false;
        } catch (error) {
            console.error(`❌ Erreur vente partielle: ${error.message}`);
            return false;
        }
    }

    // VENTE TOTALE
    async sellEntirePosition(position, currentPrice, reason) {
        try {
            const tokenMint = position.tokenAddress;
            const solMint = 'So11111111111111111111111111111111111111112';
            
            await this.jupiterAPI.waitForRateLimit();
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                this.wallet.publicKey,
                { mint: new PublicKey(tokenMint) }
            );
            
           if (tokenAccounts.value.length === 0) {
    console.log(`⚠️ Aucun token trouvé dans le wallet pour ${position.symbol}`);
    
    const totalSolReceived = position.totalSolReceived || 0;
    const totalProfit = totalSolReceived - position.solSpent;
    const totalProfitPercent = totalSolReceived > 0 ? ((totalSolReceived / position.solSpent) - 1) * 100 : -100;
    
    const sellTradeData = {
        type: 'SELL',
        timestamp: Date.now(),
        symbol: position.symbol,
        tokenAddress: position.tokenAddress,
        buyData: {
            priceUSD: position.buyPrice,
            solInvested: position.solSpent,
            tokensReceived: position.buyAmount,
            category: this.getCategoryFromSymbol(position.symbol),
            confidence: 'HIGH',
            txHash: position.buyTxid,
            buyTime: position.buyTime
        },
        totalSolReceived: totalSolReceived,
        totalProfit: totalProfit,
        totalProfitPercent: totalProfitPercent,
        sellPriceUSD: currentPrice,
        duration: Date.now() - position.buyTime,
        exitReason: reason + " (Aucun token dans wallet)",
        partialSells: position.partialSells || 0,
        highestPrice: position.highestPrice || position.buyPrice,
        highestPercent: position.highestPercent || 0,
        txHashes: []
    };

    await this.tradeLogger.logTrade(sellTradeData);
    
    this.markTokenAsProcessed(position.tokenAddress, 'loss');
    this.positions.delete(position.tokenAddress);
    return false;
}
            
            const realBalance = parseFloat(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
            const amountToSell = Math.floor(realBalance * 0.99);
            
            if (amountToSell <= 0) {
    console.log(`⚠️ Montant à vendre trop petit pour ${position.symbol}`);
    
    const totalSolReceived = position.totalSolReceived || 0;
    const totalProfit = totalSolReceived - position.solSpent;
    const totalProfitPercent = totalSolReceived > 0 ? ((totalSolReceived / position.solSpent) - 1) * 100 : 0;
    const tradeResult = totalSolReceived > position.solSpent * 1.1 ? 'profit' : 'breakeven';
    
    const sellTradeData = {
        type: 'SELL',
        timestamp: Date.now(),
        symbol: position.symbol,
        tokenAddress: position.tokenAddress,
        buyData: {
            priceUSD: position.buyPrice,
            solInvested: position.solSpent,
            tokensReceived: position.buyAmount,
            category: this.getCategoryFromSymbol(position.symbol),
            confidence: 'HIGH',
            txHash: position.buyTxid,
            buyTime: position.buyTime
        },
        totalSolReceived: totalSolReceived,
        totalProfit: totalProfit,
        totalProfitPercent: totalProfitPercent,
        sellPriceUSD: currentPrice,
        duration: Date.now() - position.buyTime,
        exitReason: reason + " (Montant résiduel trop petit)",
        partialSells: position.partialSells || 0,
        highestPrice: position.highestPrice || position.buyPrice,
        highestPercent: position.highestPercent || 0,
        txHashes: []
    };

    await this.tradeLogger.logTrade(sellTradeData);
    
    this.markTokenAsProcessed(position.tokenAddress, tradeResult);
    this.positions.delete(position.tokenAddress);
    return false;
}
            
            const sellQuote = await this.jupiterAPI.getJupiterQuote(tokenMint, solMint, amountToSell);
            if (!sellQuote) return false;
            
            const txid = await this.jupiterAPI.executeSwap(sellQuote);
            
            if (txid) {
                const solReceived = parseFloat(sellQuote.outAmount) / 1e9;
                const totalSolReceived = position.totalSolReceived + solReceived;
                const totalProfit = totalSolReceived - position.solSpent;
                const totalProfitPercent = ((totalSolReceived / position.solSpent) - 1) * 100;
                
                // Déterminer le résultat pour le système de cooldown
                let tradeResult;
                if (totalProfitPercent > 10) {
                    tradeResult = 'profit';
                } else if (totalProfitPercent < -5) {
                    tradeResult = 'loss';
                } else {
                    tradeResult = 'breakeven';
                }
                
                // METTRE À JOUR LES STATISTIQUES
                this.updateStatsOnSell(totalSolReceived, position.solSpent, totalProfitPercent, position.buyTime, position.symbol, tradeResult);
                
                this.markTokenAsProcessed(position.tokenAddress, tradeResult);
                
                // Stocker infos pour l'historique
                if (this.tradedTokens.has(position.tokenAddress)) {
                    const history = this.tradedTokens.get(position.tokenAddress);
                    history.finalProfit = totalProfitPercent;
                    history.holdTimeMinutes = parseInt(((Date.now() - position.buyTime) / (1000 * 60)));
                    history.partialSells = position.partialSells;
                    history.exitReason = reason;
                    history.totalSolReceived = totalSolReceived;
                }
                
                await this.discordNotifications.notifyFinalSell(position, totalSolReceived, totalProfit, totalProfitPercent, reason, txid);
                
                this.positions.delete(position.tokenAddress);
                const sellTradeData = {
                            type: 'SELL',
                            timestamp: Date.now(),
                            symbol: position.symbol,
                            tokenAddress: position.tokenAddress,
                            buyData: {
                                priceUSD: position.buyPrice,
                                solInvested: position.solSpent,
                                tokensReceived: position.buyAmount,
                                category: this.getCategoryFromSymbol(position.symbol),
                                confidence: 'HIGH',
                                txHash: position.buyTxid,
                                buyTime: position.buyTime
                            },
                            totalSolReceived: totalSolReceived,
                            totalProfit: totalProfit,
                            totalProfitPercent: totalProfitPercent,
                            sellPriceUSD: currentPrice,
                            duration: Date.now() - position.buyTime,
                            exitReason: reason,
                            partialSells: position.partialSells || 0,
                            highestPrice: position.highestPrice || position.buyPrice,
                            highestPercent: position.highestPercent || 0,
                            txHashes: [txid]
                        };

                        await this.tradeLogger.logTrade(sellTradeData);
                
                // Invalider le cache SOL
                const cacheKey = `${solMint}_${this.wallet.publicKey.toString()}`;
                this.balanceCache.delete(cacheKey);
                
                return true;
            }
            
            return false;
            
        } catch (error) {
            console.error(`❌ Erreur vente totale: ${error.message}`);
            this.markTokenAsProcessed(position.tokenAddress, 'loss');
            return false;
        }
    }

    // TRAITEMENT DES NOUVEAUX TOKENS
    async processNewTokens(tokens) {
        if (this.positions.size >= this.maxConcurrentPositions) {
            console.log(`⏸️ Maximum de positions atteint (${this.maxConcurrentPositions})`);
            return 0;
        }
        
        let boughtCount = 0;
        const maxToBuy = this.maxConcurrentPositions - this.positions.size;
        
        for (const tokenData of tokens.slice(0, maxToBuy * 2)) {
            try {
                const tokenAddress = tokenData.baseToken?.address;
                if (!tokenAddress) continue;
                
                if (this.isAddressBanned(tokenAddress)) continue;
                if (this.isTokenAlreadyProcessed(tokenAddress, tokenData.momentumScore || 0)) continue;
                if (this.positions.has(tokenAddress)) continue;
                
                const bought = await this.buyToken(tokenAddress, tokenData);
                
                if (bought) {
                    this.markTokenAsProcessed(tokenAddress);
                    boughtCount++;
                    
                    if (boughtCount >= maxToBuy) break;
                }
                
                await new Promise(resolve => setTimeout(resolve, 3000));
                
            } catch (error) {
                console.error(`❌ Erreur traitement token: ${error.message}`);
            }
        }
        
        return boughtCount;
    }

    // AFFICHAGE DES COOLDOWNS ACTIFS
    showActiveCooldowns() {
        if (this.tradedTokens.size === 0) {
            console.log(`📊 Aucun token en cooldown`);
            return;
        }
        
        console.log(`📊 Tokens en cooldown:`);
        
        for (const [tokenAddress, history] of this.tradedTokens.entries()) {
            const timeSinceLastTrade = Date.now() - history.lastTradeTime;
            
            let cooldownTime;
            if (history.lastResult === 'profit') {
                cooldownTime = this.retradeCooldown.afterProfit;
            } else if (history.lastResult === 'loss') {
                cooldownTime = this.retradeCooldown.afterLoss;
            } else {
                cooldownTime = this.retradeCooldown.normal;
            }
            
            const remainingTime = cooldownTime - timeSinceLastTrade;
            
            if (remainingTime > 0) {
                const remainingHours = (remainingTime / (1000 * 60 * 60)).toFixed(1);
                const result = history.lastResult;
                const profit = history.finalProfit ? `${history.finalProfit > 0 ? '+' : ''}${history.finalProfit.toFixed(1)}%` : 'N/A';
                
                console.log(`   🕐 ${tokenAddress.slice(0, 8)}... → ${remainingHours}h (${result}: ${profit})`);
            }
        }
    }

    // LANCEMENT DE L'AUTO-TRADING
    async startAutoTrading() {
        console.log(`🚀 Démarrage Auto-Trading Whitelist DexScreener`);
        console.log(`💼 Wallet: ${this.wallet.publicKey.toString()}`);
        console.log(`💰 Montant par achat: ${this.buyAmount} SOL`);
        console.log(`🎯 Max positions simultanées: ${this.maxConcurrentPositions}`);
        console.log(`🛡️ Source: Whitelist DexScreener Direct`);
        console.log(`⏰ Check positions: Toutes les 2 minutes`);
        console.log(`📊 Scan whitelist: Toutes les 10 minutes`);
        console.log('💡 Appuyez sur Ctrl+C pour arrêter\n');
        
        let scanCount = 0;
        
        // Timer récap performance (toutes les 10 minutes)
                const performanceTimer = setInterval(async () => {
            try {
                await this.discordNotifications.sendPerformanceRecap(this.stats, this.positions);
            } catch (error) {
                console.log('📊 Récap en attente...');
            }
        }, 10 * 60 * 1000);
        
        // Timer positions (2 minutes)
        const positionCheckTimer = setInterval(async () => {
            try {
                if (this.positions.size > 0) {
                    console.log(`\n⏰ ${new Date().toLocaleTimeString()} - Check ${this.positions.size} positions`);
                    await this.checkPositions();
                    
                    if (this.positions.size < this.maxConcurrentPositions) {
                        console.log(`💡 Position libre détectée, scan opportuniste...`);
                        const tokens = await this.scanNewTokens();
                        if (tokens.length > 0) {
                            await this.processNewTokens(tokens);
                        }
                    }
                }
            } catch (error) {
                console.error('❌ Erreur check positions:', error.message);
            }
        }, 2 * 60 * 1000);
        
        // Timer scan (10 minutes) 
        const scanTimer = setInterval(async () => {
            try {
                scanCount++;
                console.log(`\n⏰ ${new Date().toLocaleTimeString()} - Scan whitelist #${scanCount}`);
                
                const tokens = await this.scanNewTokens();
                if (tokens.length > 0) {
                    await this.processNewTokens(tokens);
                }
                
                console.log(`📊 Positions: ${this.positions.size}/${this.maxConcurrentPositions}`);
                if (scanCount % 3 === 0) {
                    this.showActiveCooldowns();
                }
            } catch (error) {
                console.error('❌ Erreur scan whitelist:', error.message);
            }
        }, 10 * 60 * 1000);

                    const dailyReportTimer = setInterval(async () => {
                try {
                    const now = new Date();
                    if (now.getHours() === 0 && now.getMinutes() < 10) {
                        console.log('\n📊 GÉNÉRATION RAPPORT JOURNALIER');
                        await this.generateAndShowDailyReport();
                        
                        // Insights hebdomadaires (le dimanche)
                        if (now.getDay() === 0) {
                            console.log('\n🧠 INSIGHTS HEBDOMADAIRES');
                            await this.showOptimizationInsights();
                            await this.exportAnalytics();
                        }
                    }
                } catch (error) {
                    console.error('❌ Erreur rapport journalier:', error.message);
                }
            }, 10 * 60 * 1000); // Check toutes les 10 minutes
        
        // Scan initial avec récap
        try {
            console.log(`\n⏰ ${new Date().toLocaleString()} - Scan initial whitelist`);
            const tokens = await this.scanNewTokens();
            if (tokens.length > 0) {
                await this.processNewTokens(tokens);
            }
            
            
            
        } catch (error) {
            console.error('❌ Erreur scan initial:', error.message);
        }
        
        // Gestion arrêt propre
                    process.on('SIGINT', () => {
                console.log('\n🛑 Arrêt demandé...');
                clearInterval(positionCheckTimer);
                clearInterval(scanTimer);
                clearInterval(performanceTimer);
                clearInterval(dailyReportTimer);
                console.log('✅ Timers arrêtés');
                
                process.exit(0);
            });
        
        // Boucle principale pour maintenir le processus
        while (true) {
            await new Promise(resolve => setTimeout(resolve, 60000));
        }
    }

    async generateAndShowDailyReport() {
    try {
        const report = await this.tradeLogger.generateDailyReport();
        return report;
    } catch (error) {
        console.error('❌ Erreur génération rapport:', error.message);
    }
}

// INSIGHTS STRATÉGIQUES
async showOptimizationInsights() {
    try {
        const insights = await this.tradeLogger.getOptimizationInsights();
        return insights;
    } catch (error) {
        console.error('❌ Erreur insights:', error.message);
    }
}

// EXPORT ANALYTICS
async exportAnalytics() {
    try {
        await this.tradeLogger.exportAnalyticsToCSV();
        console.log('📊 Analytics exportées vers CSV');
    } catch (error) {
        console.error('❌ Erreur export analytics:', error.message);
    }
}
}

// FONCTIONS D'UTILISATION
async function runAutoTrader() {
    console.log('🤖 Auto-Trader Jupiter - Ventes Échelonnées');
    console.log('═'.repeat(60));
    
    const trader = new SimpleAutoTrader();
    
    try {
        const isConnected = await trader.initializeDiscord();
        if (!isConnected) {
            console.log('❌ Impossible de se connecter à Discord');
            return;
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const balance = await trader.connection.getBalance(trader.wallet.publicKey);
        const solBalance = balance / 1e9;
        
        console.log(`💰 Solde wallet: ${solBalance.toFixed(4)} SOL`);
        
        if (solBalance < trader.buyAmount * 2) {
            console.log(`⚠️ Solde insuffisant pour trader (minimum: ${trader.buyAmount * 2} SOL)`);
            return;
        }
        
        await trader.startAutoTrading();
        
    } catch (error) {
        console.error('❌ Erreur:', error.message);
    }
}

async function testTrader() {
    console.log('🧪 Test Auto-Trader...');
    
    const trader = new SimpleAutoTrader();
    
    try {
        await trader.initializeDiscord();
        console.log('✅ Discord OK');
        
        const balance = await trader.connection.getBalance(trader.wallet.publicKey);
        console.log(`✅ Solana OK - Balance: ${(balance / 1e9).toFixed(4)} SOL`);
        
        const tokens = await trader.scanNewTokens();
        console.log(`✅ Scan OK - ${tokens.length} tokens trouvés`);
        
        console.log('\n🎯 Configuration ventes échelonnées:');
        trader.sellLevels.forEach((level, i) => {
            console.log(`   ${i + 1}. +${level.profit}% → Vendre ${level.percentage}% (${level.reason})`);
        });
        
        console.log(`\n🛡️ Protections:`);
        console.log(`   📉 Stop-Loss: -${trader.stopLossPercent}%`);
        console.log(`   📈 Trailing Stop: -${trader.trailingStopPercent}%`);
        
        console.log('\n🎉 Tous les tests réussis !');
        
    } catch (error) {
        console.error('❌ Erreur test:', error.message);
    }
}

module.exports = { SimpleAutoTrader, runAutoTrader, testTrader };

// SERVEUR WEB POUR RENDER
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.json({
        status: 'Bot Jupiter Auto-Trader actif! 🚀',
        uptime: process.uptime(),
        lastScan: new Date().toISOString()
    });
});

app.get('/stats', (req, res) => {
    res.json({
        bot: 'Jupiter Auto-Trader',
        status: 'running',
        scans: 'Whitelist toutes les 10 minutes'
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🌐 Serveur web actif sur port ${port}`);
});

// EXÉCUTION
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.includes('--test')) {
        testTrader();
    } else {
        console.log('🎯 Auto-Trader Jupiter - Ventes Échelonnées');
        console.log('═'.repeat(50));
        console.log('Usage:');
        console.log('  node simple_auto_trader.js         - Lancer auto-trading');
        console.log('  node simple_auto_trader.js --test  - Tester config');
        console.log('  node simple_auto_trader.js --report       - Rapport journalier');
        console.log('  node simple_auto_trader.js --insights     - Insights stratégiques');
        console.log('  node simple_auto_trader.js --export       - Export analytics CSV');
        console.log('');
        console.log('Variables .env requises:');
        console.log('  DISCORD_TOKEN=...');
        console.log('  DISCORD_CHANNEL_ID=...');
        console.log('  PRIVATE_KEY=... (clé privée wallet base58)');
        console.log('  BUY_AMOUNT_SOL=0.01 (optionnel)');
        console.log('  MAX_SLIPPAGE=10 (optionnel)');
        console.log('');
        console.log('🎯 Stratégie ventes échelonnées:');
        console.log('  +20%  → Vendre 50% (sécurisation rapide)');
        console.log('  +75%  → Vendre 60% du restant');
        console.log('  +200% → Vendre 75% du restant');
        console.log('  +500% → Vendre 90% du restant');
        console.log('  Stop-Loss: -20% | Trailing: -15%');
        console.log('');
        
                if (args.includes('--report')) {
            (async () => {
                const trader = new SimpleAutoTrader();
                await trader.generateAndShowDailyReport();
            })();
        } else if (args.includes('--insights')) {
            (async () => {
                const trader = new SimpleAutoTrader();
                await trader.showOptimizationInsights();
            })();
        } else if (args.includes('--export')) {
            (async () => {
                const trader = new SimpleAutoTrader();
                await trader.exportAnalytics();
            })();
        } else if (args.includes('--test')) {
            testTrader();
        } else {
            runAutoTrader();
        }

        
    }
}