// scalping_module.js - Module de Scalping Sub-Horaire pour Solana
require('dotenv').config();
const JupiterAPI = require('./jupiter_api');
const DiscordNotifications = require('./discord_notifications');
const { Connection, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

class SolanaScalper {
    constructor() {
        // Configuration Solana
        const rpcUrls = [
            'https://api.mainnet-beta.solana.com',
            'https://rpc.ankr.com/solana',
            process.env.SOLANA_RPC_URL
        ].filter(url => url && !url.includes('undefined'));
        
        this.connection = new Connection(rpcUrls[0], {
            commitment: 'confirmed',
            wsEndpoint: false
        });

        this.wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
        this.jupiterAPI = new JupiterAPI(this.wallet, this.connection);
        
        // Discord notifications
        this.discordNotifications = new DiscordNotifications(
            process.env.DISCORD_TOKEN,
            process.env.DISCORD_CHANNEL_ID
        );
        this.whitelistPath = './whitelist.json';
        this.loadWhitelist(); // Utiliser VOTRE méthode existante (copier depuis simple_auto_trader.js)

        // Puis renommer pour cohérence :
        this.scalpWhitelist = this.whitelistedTokens; // Utiliser la même variable

        // CONFIGURATION SCALPING SPÉCIALISÉE
        this.scalpConfig = {
            // Timeframes
            primaryTimeframe: '15m',        // Focus principal
            detectionTimeframe: '5m',       // Détection précoce
            
            // Critères momentum sub-horaire
            minMomentum5m: 1.5,            // +1.5% sur 5min minimum
            maxMomentum5m: 18,             // +18% max sur 5min (évite parabolic)
            minMomentum15m: 2.5,           // +2.5% sur 15min minimum
            maxMomentum15m: 25,            // +25% max sur 15min
            
            // Critères long-term (moins restrictifs pour scalp)
            minMomentum1h: -3,             // Accepte correction 1h
            maxMomentum1h: 100,            // Pas de limite 1h
            minMomentum24h: -5,            // Accepte correction 24h
            
            // Volume et liquidité (adaptés au scalping)
            minVolume15m: 25000,           // $25k volume 15min
            minVolume1h: 75000,            // $75k volume 1h  
            minLiquidity: 15000,           // $15k liquidité minimum
            
            // Position sizing pour scalp
            basePositionSize: 0.01,       // 0.008 SOL par position (plus petit)
            maxPositions: 15,              // Plus de positions simultanées
            
            // Timing
            maxHoldTime: 45 * 60 * 1000,   // 45min max hold
            minHoldTime: 3 * 60 * 1000,    // 3min min hold (évite micro-trades)
            scanInterval: 90 * 1000,        // Scan toutes les 90 secondes
        };

        // VENTES SCALPING ULTRA-RAPIDES
        this.scalpSellLevels = [
            { profit: 3, percentage: 30, reason: "Scalp sécurisé (+3%)", timeframe: "3-8min" },
            { profit: 6, percentage: 50, reason: "Scalp rapide (+6%)", timeframe: "8-15min" },  
            { profit: 12, percentage: 70, reason: "Scalp excellent (+12%)", timeframe: "15-30min" },
            { profit: 20, percentage: 90, reason: "Scalp moonshot (+20%)", timeframe: "30min+" }
        ];

        // PROTECTIONS SCALPING
        this.scalpProtection = {
            stopLoss: 5,                   // -5% stop loss (plus serré)
            trailingStop: 4,               // -4% trailing stop
            stagnationTime: 15 * 60 * 1000, // 15min = stagnant
            stagnationThreshold: 2,        // ±2% = stagnant
            maxDrawdown: 8,                // -8% drawdown max
        };

        // État
        this.scalpPositions = new Map();
        this.scalpStats = {
            totalScalps: 0,
            successfulScalps: 0,
            avgHoldTimeMin: 0,
            avgProfitPercent: 0,
            fastestScalp: null,            // Plus rapide en minutes
            bestScalp: null,               // Meilleur %
            totalScalpTime: 0
        };
        this.bannedAddresses = new Set();

        console.log(`🏃‍♂️ SCALPER SOLANA INITIALISÉ`);
        console.log(`⚡ Timeframes: 5m detection, 15m primary`);
        console.log(`💰 Position size: ${this.scalpConfig.basePositionSize} SOL`);
        console.log(`⏰ Max hold: ${this.scalpConfig.maxHoldTime / (60*1000)}min`);
        console.log(`🎯 Targets: 3%, 6%, 12%, 20%`);
    }
    loadWhitelist() {
    try {
        const fs = require('fs');
        
        if (fs.existsSync(this.whitelistPath)) {
            const whitelistData = JSON.parse(fs.readFileSync(this.whitelistPath, 'utf8'));
            
            this.whitelistedTokens = {};
            
            // Votre format: whitelistData.tokens.SYMBOL.address
            for (const [symbol, data] of Object.entries(whitelistData.tokens)) {
                if (data.verified && data.address) {
                    this.whitelistedTokens[symbol] = data.address;
                }
            }
            
            console.log(`✅ Whitelist scalping chargée: ${Object.keys(this.whitelistedTokens).length} tokens`);
            console.log(`🎯 Tokens: ${Object.keys(this.whitelistedTokens).join(', ')}`);
            
        } else {
            console.log(`❌ ERREUR: Fichier whitelist INTROUVABLE: ${this.whitelistPath}`);
            throw new Error('Whitelist fichier requis !');
        }
        
    } catch (error) {
        console.error(`❌ Erreur chargement whitelist: ${error.message}`);
        process.exit(1);
    }
}
    // RÉCUPÉRATION DONNÉES MULTI-TIMEFRAMES
    async getMultiTimeframeData(tokenAddress, symbol) {
        try {
            const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
            
            if (!response.ok) return null;
            
            const data = await response.json();
            const pair = data.pairs?.find(p => p.chainId === 'solana');
            
            if (!pair) return null;
            
            return {
                symbol: symbol,
                address: tokenAddress,
                
                // Prix et liquidité
                price: parseFloat(pair.priceUsd || 0),
                liquidity: parseFloat(pair.liquidity?.usd || 0),
                marketCap: parseFloat(pair.marketCap || 0),
                
                // Timeframes momentum
                change5m: parseFloat(pair.priceChange?.m5 || 0),
                change15m: parseFloat(pair.priceChange?.m15 || 0),
                change30m: parseFloat(pair.priceChange?.m30 || 0),
                change1h: parseFloat(pair.priceChange?.h1 || 0),
                change6h: parseFloat(pair.priceChange?.h6 || 0),
                change24h: parseFloat(pair.priceChange?.h24 || 0),
                
                // Volume timeframes
                volume5m: parseFloat(pair.volume?.m5 || 0),
                volume15m: parseFloat(pair.volume?.m15 || 0),
                volume1h: parseFloat(pair.volume?.h1 || 0),
                volume24h: parseFloat(pair.volume?.h24 || 0),
                
                // Données brutes pour analyse
                pair: pair,
                timestamp: Date.now()
            };
            
        } catch (error) {
            console.log(`❌ Erreur data ${symbol}:`, error.message);
            return null;
        }
    }

    // ANALYSE DES PATTERNS DE SCALPING
    // ANALYSE DES PATTERNS DE SCALPING (VERSION CORRIGÉE)
analyzeScalpPattern(data) {
    const {symbol, change5m, change15m, change30m, change1h, change24h, volume15m, volume1h, volume24h, liquidity} = data;
    
    // NOUVEAU : Utiliser timeframes disponibles avec fallbacks
    const shortTerm = change30m !== 0 ? change30m : change1h;     // 30m ou fallback 1h
    const mediumTerm = change1h !== 0 ? change1h : change24h;     // 1h ou fallback 24h
    const volume = volume1h > 0 ? volume1h : volume24h;          // Volume 1h ou 24h
    
    console.log(`🔍 Analyse ${symbol}: 30m(${shortTerm.toFixed(1)}%) 1h(${mediumTerm.toFixed(1)}%) Vol1h($${volume.toLocaleString()})`);
    
    // PATTERN 1: BREAKOUT MEDIUM ⚡
    if (shortTerm >= 1.5 && mediumTerm >= 2 && 
        volume >= 50000 && // $50k volume minimum
        shortTerm <= 15 && mediumTerm <= 50) {
        
        return {
            pattern: 'BREAKOUT_MEDIUM',
            score: 85,
            confidence: 'HIGH',
            reason: `Breakout: 30m(${shortTerm.toFixed(1)}%) 1h(${mediumTerm.toFixed(1)}%)`,
            expectedMove: `+${(shortTerm * 1.3).toFixed(0)}%`,
            targetTime: '20-45min',
            riskLevel: 'LOW'
        };
    }
    
    // PATTERN 2: STRONG MOMENTUM 🚀
    if (mediumTerm >= 5 && change24h >= 8 && 
        mediumTerm < change24h * 1.5 && // Pas trop parabolic
        volume >= 100000) {
        
        return {
            pattern: 'STRONG_MOMENTUM',
            score: 80,
            confidence: 'HIGH',
            reason: `Strong momentum: 1h(${mediumTerm.toFixed(1)}%) 24h(${change24h.toFixed(1)}%)`,
            expectedMove: `+${(mediumTerm * 0.8).toFixed(0)}%`,
            targetTime: '30-60min',
            riskLevel: 'MEDIUM'
        };
    }
    
    // PATTERN 3: VOLUME BREAKOUT 📊
    if (shortTerm >= 1 && volume >= 150000 && 
        liquidity > 20000) {
        
        return {
            pattern: 'VOLUME_BREAKOUT',
            score: 75,
            confidence: 'MEDIUM',
            reason: `Volume breakout: 30m(${shortTerm.toFixed(1)}%) Vol($${volume.toLocaleString()})`,
            expectedMove: `+${(shortTerm * 2).toFixed(0)}%`,
            targetTime: '15-30min',
            riskLevel: 'MEDIUM'
        };
    }
    
    // PATTERN 4: RECOVERY PLAY 📈
    if (shortTerm >= 2 && mediumTerm < 0 && change24h > 0 && 
        liquidity > 25000) {
        
        return {
            pattern: 'RECOVERY_PLAY',
            score: 70,
            confidence: 'MEDIUM',
            reason: `Recovery: 30m(${shortTerm.toFixed(1)}%) depuis correction`,
            expectedMove: `+${(Math.abs(mediumTerm) * 0.5).toFixed(0)}%`,
            targetTime: '20-40min',
            riskLevel: 'HIGH'
        };
    }
    
    // REJET - Critères adaptés
    let rejectReason = [];
    if (shortTerm < 1) rejectReason.push(`30m faible(${shortTerm.toFixed(1)}%)`);
    if (mediumTerm < -10) rejectReason.push(`1h très négatif(${mediumTerm.toFixed(1)}%)`);
    if (volume < 50000) rejectReason.push(`Volume faible($${volume.toLocaleString()})`);
    if (shortTerm > 20) rejectReason.push(`30m trop chaud(${shortTerm.toFixed(1)}%)`);
    
    return {
        pattern: 'NO_PATTERN',
        score: 0,
        confidence: 'NONE',
        reason: rejectReason.join(', ') || 'Critères insuffisants',
        expectedMove: 'N/A',
        targetTime: 'N/A',
        riskLevel: 'NONE'
    };
}
    // SCANNER TOKENS POUR SCALPING
    async scanScalpingOpportunities() {
        console.log('\n🏃‍♂️ SCAN SCALPING...');
        
        const opportunities = [];
        const tokens = Object.entries(this.scalpWhitelist);
        
        for (const [symbol, address] of tokens) {
            try {
                // Skip si déjà en position
                if (this.scalpPositions.has(address)) continue;
                if (this.isAddressBanned && this.isAddressBanned(address)) continue;
                const data = await this.getMultiTimeframeData(address, symbol);
                if (!data) continue;
                
                const pattern = this.analyzeScalpPattern(data);
                
                if (pattern.score >= 70) {
                    console.log(`   🎯 ${symbol} QUALIFIÉ: ${pattern.pattern} (${pattern.score}pts)`);
                    console.log(`      💡 ${pattern.reason}`);
                    console.log(`      🎲 Expected: ${pattern.expectedMove} in ${pattern.targetTime}`);
                    
                    opportunities.push({
                        ...data,
                        pattern: pattern,
                        priority: pattern.score
                    });
                } else {
                    console.log(`   ❌ ${symbol}: ${pattern.reason}`);
                }
                
                // Rate limiting
                await new Promise(resolve => setTimeout(resolve, 500));
                
            } catch (error) {
                console.log(`   ❌ ${symbol} erreur: ${error.message}`);
            }
        }
        
        // Trier par score descendant
        opportunities.sort((a, b) => b.priority - a.priority);
        
        console.log(`🎯 ${opportunities.length} opportunités trouvées`);
        return opportunities;
    }

    // EXÉCUTION ACHAT SCALP
    async executeScalpBuy(opportunity) {
        const {symbol, address, price, pattern} = opportunity;
        
        try {
            console.log(`\n🚀 ACHAT SCALP: ${symbol}`);
            console.log(`   📊 Pattern: ${pattern.pattern} (${pattern.confidence})`);
            console.log(`   💰 Prix: ${price.toFixed(6)}`);
            console.log(`   🎯 Target: ${pattern.expectedMove} in ${pattern.targetTime}`);
            
            // Calculer position size
            let positionSize = this.scalpConfig.basePositionSize;
            
            
            
            // Achat via Jupiter
            const solAmount = positionSize * 1e9;
            const solMint = 'So11111111111111111111111111111111111111112';
            
            const buyQuote = await this.jupiterAPI.getJupiterQuote(solMint, address, solAmount, false);
            if (!buyQuote) {
                console.log(`❌ Quote impossible pour ${symbol}`);
                return false;
            }
            
            const txid = await this.jupiterAPI.executeSwap(buyQuote);
            
            if (txid) {
                const tokenAmount = parseFloat(buyQuote.outAmount);
                
                // Créer position scalp
                const scalpPosition = {
                    tokenAddress: address,
                    symbol: symbol,
                    buyPrice: price,
                    buyAmount: tokenAmount,
                    currentAmount: tokenAmount,
                    buyTxid: txid,
                    buyTime: Date.now(),
                    solSpent: positionSize,
                    
                    // Scalp specific
                    pattern: pattern.pattern,
                    expectedMove: pattern.expectedMove,
                    targetTime: pattern.targetTime,
                    confidence: pattern.confidence,
                    riskLevel: pattern.riskLevel,
                    
                    // Tracking
                    highestPrice: price,
                    highestPercent: 0,
                    sellsExecuted: [],
                    totalSolReceived: 0,
                    isScalp: true,
                    
                    // Timeouts
                    maxHoldTime: this.scalpConfig.maxHoldTime,
                    minHoldTime: this.scalpConfig.minHoldTime
                };
                
                this.scalpPositions.set(address, scalpPosition);
                this.scalpStats.totalScalps++;
                
                console.log(`✅ SCALP ACHETÉ: ${symbol}`);
                console.log(`   🪙 Quantité: ${tokenAmount.toLocaleString()}`);
                console.log(`   💎 Investissement: ${positionSize.toFixed(4)} SOL`);
                console.log(`   🔗 TX: ${txid}`);
                
                // Notification Discord
                await this.notifyScalpBuy(scalpPosition);
                
                return true;
            }
            
            return false;
            
        } catch (error) {
            console.error(`❌ Erreur achat scalp ${symbol}:`, error.message);
            return false;
        }
    }
    isAddressBanned(tokenAddress) {
    return this.bannedAddresses && this.bannedAddresses.has(tokenAddress);
}
    // SURVEILLANCE POSITIONS SCALP
    async checkScalpPositions() {
        if (this.scalpPositions.size === 0) return;
        
        console.log(`\n⚡ CHECK ${this.scalpPositions.size} positions scalp...`);
        
        for (const [address, position] of this.scalpPositions.entries()) {
            try {
                await this.checkSingleScalpPosition(address, position);
                await new Promise(resolve => setTimeout(resolve, 1000)); // 1s entre positions
            } catch (error) {
                console.error(`❌ Erreur check scalp ${position.symbol}:`, error.message);
            }
        }
    }

    // CHECK POSITION SCALP INDIVIDUELLE
    async checkSingleScalpPosition(address, position) {
        try {
            // Obtenir prix actuel
            const data = await this.getMultiTimeframeData(address, position.symbol);
            if (!data) return;
            
            const currentPrice = data.price;
            const changePercent = ((currentPrice / position.buyPrice) - 1) * 100;
            const holdTime = Date.now() - position.buyTime;
            const holdTimeMin = Math.floor(holdTime / (60 * 1000));
            
            // Mettre à jour highest
            if (currentPrice > position.highestPrice) {
                position.highestPrice = currentPrice;
                position.highestPercent = changePercent;
            }
            
            console.log(`   ⚡ ${position.symbol}: ${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}% (${holdTimeMin}min) [${position.pattern}]`);
            
            // 1. VÉRIFIER MIN HOLD TIME
            if (holdTime < position.minHoldTime) {
                console.log(`      ⏳ Min hold time pas atteint (${position.minHoldTime / 60000}min)`);
                return;
            }
            
            // 2. VÉRIFIER MAX HOLD TIME
            if (holdTime > position.maxHoldTime) {
                console.log(`      ⏰ Max hold time atteint (${holdTimeMin}min)`);
                await this.sellScalpPosition(position, currentPrice, 'TIMEOUT');
                return;
            }
            
            // 3. STOP LOSS
            if (changePercent <= -this.scalpProtection.stopLoss) {
                console.log(`      🛑 Stop loss scalp: ${changePercent.toFixed(1)}%`);
                await this.sellScalpPosition(position, currentPrice, 'STOP_LOSS');
                return;
            }
            
            // 4. TRAILING STOP
            if (position.highestPercent > 0) {
                const trailingStopPrice = position.highestPrice * (1 - this.scalpProtection.trailingStop / 100);
                if (currentPrice <= trailingStopPrice) {
                    const trailingLoss = ((currentPrice / position.highestPrice) - 1) * 100;
                    console.log(`      📉 Trailing stop scalp: ${trailingLoss.toFixed(1)}% depuis +${position.highestPercent.toFixed(1)}%`);
                    await this.sellScalpPosition(position, currentPrice, 'TRAILING_STOP');
                    return;
                }
            }
            
            // 5. STAGNATION EXIT
            if (holdTime > this.scalpProtection.stagnationTime && 
                Math.abs(changePercent) < this.scalpProtection.stagnationThreshold) {
                console.log(`      😴 Stagnation scalp: ${changePercent.toFixed(1)}% depuis ${holdTimeMin}min`);
                await this.sellScalpPosition(position, currentPrice, 'STAGNATION');
                return;
            }
            
            // 6. VENTES ÉCHELONNÉES SCALP
            await this.checkScalpSellLevels(position, changePercent, currentPrice);
            
        } catch (error) {
            console.error(`❌ Erreur check position scalp ${position.symbol}:`, error.message);
        }
    }

    // VENTES ÉCHELONNÉES SCALP
    async checkScalpSellLevels(position, changePercent, currentPrice) {
        for (const level of this.scalpSellLevels) {
            if (changePercent >= level.profit && !position.sellsExecuted.includes(level.profit)) {
                
                const remainingAmount = position.currentAmount;
                const amountToSell = remainingAmount * (level.percentage / 100);
                
                if (amountToSell > 0) {
                    const holdTimeMin = Math.floor((Date.now() - position.buyTime) / (60 * 1000));
                    
                    console.log(`      🎯 VENTE SCALP: ${position.symbol} +${changePercent.toFixed(1)}% (${holdTimeMin}min)`);
                    console.log(`         💰 Vendre ${level.percentage}% à +${level.profit}%`);
                    
                    const success = await this.sellPartialScalp(position, amountToSell, level, currentPrice);
                    
                    if (success) {
                        position.sellsExecuted.push(level.profit);
                        position.currentAmount = remainingAmount - amountToSell;
                        
                        // Si plus rien à vendre, fermer position
                        if (position.currentAmount <= position.buyAmount * 0.01) {
                            console.log(`      ✅ Scalp ${position.symbol} entièrement vendu`);
                            this.scalpPositions.delete(position.tokenAddress);
                            this.updateScalpStats(position, 'COMPLETED');
                            break;
                        }
                    }
                }
            }
        }
    }

    // VENTE PARTIELLE SCALP
    async sellPartialScalp(position, amountToSell, level, currentPrice) {
        try {
            const tokenMint = position.tokenAddress;
            const solMint = 'So11111111111111111111111111111111111111112';
            const roundedAmount = Math.floor(amountToSell);
            
            if (roundedAmount <= 0) return false;
            
            const sellQuote = await this.jupiterAPI.getJupiterQuote(tokenMint, solMint, roundedAmount);
            if (!sellQuote) return false;
            
            const txid = await this.jupiterAPI.executeSwap(sellQuote);
            
            if (txid) {
                const solReceived = parseFloat(sellQuote.outAmount) / 1e9;
                const partialProfit = solReceived - (position.solSpent * (level.percentage / 100));
                const partialProfitPercent = ((currentPrice / position.buyPrice) - 1) * 100;
                const holdTimeMin = Math.floor((Date.now() - position.buyTime) / (60 * 1000));
                
                position.totalSolReceived += solReceived;
                
                console.log(`         ✅ Vente partielle réussie: ${solReceived.toFixed(4)} SOL (+${partialProfitPercent.toFixed(1)}%)`);
                
                // Notification Discord
                await this.notifyPartialScalpSell(position, solReceived, partialProfit, partialProfitPercent, level, holdTimeMin);
                
                return true;
            }
            
            return false;
        } catch (error) {
            console.error(`❌ Erreur vente partielle scalp: ${error.message}`);
            return false;
        }
    }

    // VENTE TOTALE POSITION SCALP
    async sellScalpPosition(position, currentPrice, reason) {
        try {
            const tokenMint = position.tokenAddress;
            const solMint = 'So11111111111111111111111111111111111111112';
            
            // Obtenir solde réel
            const realBalance = await this.jupiterAPI.getRealTokenBalance(tokenMint);
            const amountToSell = Math.floor(realBalance * 0.99);
            
            if (amountToSell <= 0) {
                this.scalpPositions.delete(position.tokenAddress);
                this.updateScalpStats(position, reason);
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
                const holdTimeMin = Math.floor((Date.now() - position.buyTime) / (60 * 1000));
                
                console.log(`      ✅ SCALP FERMÉ: ${position.symbol}`);
                console.log(`         💰 Total reçu: ${totalSolReceived.toFixed(4)} SOL`);
                console.log(`         📈 Profit: ${totalProfit > 0 ? '+' : ''}${totalProfit.toFixed(4)} SOL (${totalProfitPercent > 0 ? '+' : ''}${totalProfitPercent.toFixed(1)}%)`);
                console.log(`         ⏱️ Durée: ${holdTimeMin}min`);
                console.log(`         🎯 Raison: ${reason}`);
                
                // Mettre à jour stats
                this.updateScalpStats(position, reason, totalProfitPercent, holdTimeMin);
                
                // Notification Discord
                await this.notifyScalpClose(position, totalSolReceived, totalProfit, totalProfitPercent, reason, holdTimeMin);
                
                this.scalpPositions.delete(position.tokenAddress);
                return true;
            }
            
            return false;
            
        } catch (error) {
            console.error(`❌ Erreur vente totale scalp: ${error.message}`);
            return false;
        }
    }

    // MISE À JOUR STATISTIQUES SCALP
    updateScalpStats(position, result, profitPercent = 0, holdTimeMin = 0) {
        this.scalpStats.totalScalpTime += holdTimeMin;
        this.scalpStats.avgHoldTimeMin = this.scalpStats.totalScalpTime / this.scalpStats.totalScalps;
        
        if (profitPercent > 0) {
            this.scalpStats.successfulScalps++;
            this.scalpStats.avgProfitPercent = 
                ((this.scalpStats.avgProfitPercent * (this.scalpStats.successfulScalps - 1)) + profitPercent) 
                / this.scalpStats.successfulScalps;
        }
        
        // Record fastest scalp
        if (holdTimeMin > 0 && (!this.scalpStats.fastestScalp || holdTimeMin < this.scalpStats.fastestScalp.time)) {
            this.scalpStats.fastestScalp = {
                symbol: position.symbol,
                time: holdTimeMin,
                profit: profitPercent
            };
        }
        
        // Record best scalp
        if (profitPercent > 0 && (!this.scalpStats.bestScalp || profitPercent > this.scalpStats.bestScalp.profit)) {
            this.scalpStats.bestScalp = {
                symbol: position.symbol,
                profit: profitPercent,
                time: holdTimeMin
            };
        }
    }

    // NOTIFICATIONS DISCORD SCALP
    async notifyScalpBuy(position) {
    console.log(`📨 Discord: SCALP ENTRY ${position.symbol} - ${position.pattern}`);
    
    try {
        // Utiliser la méthode notifyBuy existante avec données adaptées
        const tokenData = {
            baseToken: { symbol: position.symbol, name: position.symbol },
            priceUsd: position.buyPrice.toString(),
            volume: { h24: 100000 }, // Données factices pour compatibilité
            liquidity: { usd: 50000 },
            priceChange: { h1: 5, h24: 10 }
        };
        
        const sellLevels = this.scalpSellLevels;
        const stopLossPercent = this.scalpProtection.stopLoss;
        
        await this.discordNotifications.notifyBuy(position, tokenData, sellLevels, stopLossPercent);
    } catch (error) {
        console.error('❌ Erreur notification Discord buy:', error.message);
    }
}

async notifyPartialScalpSell(position, solReceived, profit, profitPercent, level, holdTimeMin) {
    console.log(`📨 Discord: SCALP PARTIAL ${position.symbol} +${profitPercent.toFixed(1)}%`);
    
    try {
        await this.discordNotifications.notifyPartialSell(
            position, 
            solReceived, 
            profit, 
            profitPercent, 
            level, 
            position.buyTxid
        );
    } catch (error) {
        console.error('❌ Erreur notification Discord partial:', error.message);
    }
}

async notifyScalpClose(position, totalReceived, totalProfit, totalProfitPercent, reason, holdTimeMin) {
    console.log(`📨 Discord: SCALP CLOSED ${position.symbol} ${totalProfitPercent > 0 ? '+' : ''}${totalProfitPercent.toFixed(1)}%`);
    
    try {
        await this.discordNotifications.notifyFinalSell(
            position,
            totalReceived,
            totalProfit, 
            totalProfitPercent,
            reason,
            position.buyTxid
        );
    } catch (error) {
        console.error('❌ Erreur notification Discord close:', error.message);
    }
}

    // AFFICHAGE STATISTIQUES SCALP
    displayScalpStats() {
        const winRate = this.scalpStats.totalScalps > 0 ? 
            ((this.scalpStats.successfulScalps / this.scalpStats.totalScalps) * 100).toFixed(1) : '0';
        
        console.log('\n📊 SCALP STATISTICS');
        console.log('═'.repeat(50));
        console.log(`Total scalps: ${this.scalpStats.totalScalps}`);
        console.log(`Successful: ${this.scalpStats.successfulScalps} (${winRate}%)`);
        console.log(`Avg hold time: ${this.scalpStats.avgHoldTimeMin.toFixed(1)}min`);
        console.log(`Avg profit: ${this.scalpStats.avgProfitPercent.toFixed(1)}%`);
        
        if (this.scalpStats.fastestScalp) {
            console.log(`Fastest: ${this.scalpStats.fastestScalp.symbol} (${this.scalpStats.fastestScalp.time}min, +${this.scalpStats.fastestScalp.profit.toFixed(1)}%)`);
        }
        
        if (this.scalpStats.bestScalp) {
            console.log(`Best: ${this.scalpStats.bestScalp.symbol} (+${this.scalpStats.bestScalp.profit.toFixed(1)}%, ${this.scalpStats.bestScalp.time}min)`);
        }
        
        console.log(`Active positions: ${this.scalpPositions.size}`);
        console.log('═'.repeat(50));
    }

    // LANCEMENT SCALPING AUTO
    async startScalping() {
        console.log(`\n🏃‍♂️ DÉMARRAGE SCALPER SOLANA`);
        console.log(`⚡ Scan interval: ${this.scalpConfig.scanInterval / 1000}s`);
        console.log(`💰 Position size: ${this.scalpConfig.basePositionSize} SOL`);
        console.log(`🎯 Max positions: ${this.scalpConfig.maxPositions}`);
        console.log(`📊 Whitelist: ${Object.keys(this.scalpWhitelist).length} tokens`);
        console.log('💡 Appuyez sur Ctrl+C pour arrêter\n');
        
        let scanCount = 0;
        
        // Timer principal scalping
        const scalpTimer = setInterval(async () => {
            try {
                scanCount++;
                console.log(`\n⏰ ${new Date().toLocaleTimeString()} - SCAN SCALP #${scanCount}`);
                
                // Check positions existantes d'abord
                if (this.scalpPositions.size > 0) {
                    await this.checkScalpPositions();
                }
                
                // Scanner nouvelles opportunités si on a de la place
                if (this.scalpPositions.size < this.scalpConfig.maxPositions) {
                    const opportunities = await this.scanScalpingOpportunities();
                    
                    if (opportunities.length > 0) {
                        const maxNewBuys = this.scalpConfig.maxPositions - this.scalpPositions.size;
                        
                        for (let i = 0; i < Math.min(opportunities.length, maxNewBuys); i++) {
                            await this.executeScalpBuy(opportunities[i]);
                            await new Promise(resolve => setTimeout(resolve, 3000)); // 3s entre achats
                        }
                    }
                }
                
                // Afficher stats toutes les 10 scans
                if (scanCount % 10 === 0) {
                    this.displayScalpStats();
                }
                
            } catch (error) {
                console.error('❌ Erreur scan scalping:', error.message);
            }
        }, this.scalpConfig.scanInterval);
        
        // Timer positions (plus fréquent pour scalp)
        const positionTimer = setInterval(async () => {
            try {
                if (this.scalpPositions.size > 0) {
                    await this.checkScalpPositions();
                }
            } catch (error) {
                console.error('❌ Erreur check positions scalp:', error.message);
            }
        }, 30000); // 30 secondes
        
        // Scan initial
        try {
            console.log(`\n⏰ ${new Date().toLocaleString()} - SCAN SCALP INITIAL`);
            const opportunities = await this.scanScalpingOpportunities();
            
            if (opportunities.length > 0) {
                const maxBuys = Math.min(opportunities.length, 3); // Max 3 positions initiales
                
                for (let i = 0; i < maxBuys; i++) {
                    await this.executeScalpBuy(opportunities[i]);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }
        } catch (error) {
            console.error('❌ Erreur scan initial:', error.message);
        }
        
        // Arrêt propre
        process.on('SIGINT', () => {
            console.log('\n🛑 Arrêt scalper...');
            clearInterval(scalpTimer);
            clearInterval(positionTimer);
            
            if (this.scalpPositions.size > 0) {
                console.log(`⚠️ ${this.scalpPositions.size} positions scalp actives`);
                console.log('💡 Utilisez le mode manuel pour les fermer');
            }
            
            this.displayScalpStats();
            console.log('✅ Scalper arrêté');
            process.exit(0);
        });
        
        // Maintenir le processus
        while (true) {
            await new Promise(resolve => setTimeout(resolve, 60000));
        }
    }
}

// FONCTION DE TEST SCALPING
async function testScalping() {
    console.log('🧪 TEST SCALPING MODULE...');
    
    const scalper = new SolanaScalper();
    
    try {
        // Test connection
        const balance = await scalper.connection.getBalance(scalper.wallet.publicKey);
        console.log(`✅ Solana OK - Balance: ${(balance / 1e9).toFixed(4)} SOL`);
        
        // Test Discord (optionnel)
        console.log('⚠️ Discord notifications désactivées en mode test');
        
        // Test scan
        console.log('🔍 Test scan opportunités...');
        const opportunities = await scalper.scanScalpingOpportunities();
        console.log(`✅ Scan OK - ${opportunities.length} opportunités trouvées`);
        
        if (opportunities.length > 0) {
            console.log('\n🎯 TOP OPPORTUNITÉS:');
            opportunities.slice(0, 3).forEach((opp, i) => {
                console.log(`   ${i + 1}. ${opp.symbol}: ${opp.pattern.pattern} (${opp.pattern.score}pts)`);
                console.log(`      💡 ${opp.pattern.reason}`);
                console.log(`      🎯 ${opp.pattern.expectedMove} in ${opp.pattern.targetTime}`);
            });
        }
        
        console.log('\n🎉 Test scalping réussi !');
        console.log('💡 Pour lancer: node scalping_module.js --run');
        
    } catch (error) {
        console.error('❌ Erreur test scalping:', error.message);
    }
}

// FONCTION DE LANCEMENT
async function runScalper() {
    const scalper = new SolanaScalper();
    
    try {
        // Vérifications initiales
        const balance = await scalper.connection.getBalance(scalper.wallet.publicKey);
        const solBalance = balance / 1e9;
        
        console.log(`💰 Solde wallet: ${solBalance.toFixed(4)} SOL`);
        
        if (solBalance < scalper.scalpConfig.basePositionSize * 5) {
            console.log(`⚠️ Solde faible pour scalping (recommandé: ${(scalper.scalpConfig.basePositionSize * 5).toFixed(3)} SOL minimum)`);
            return;
        }
        
        // Initialiser Discord (optionnel)
        try {
            await scalper.discordNotifications.initialize();
            console.log('✅ Discord connecté');
        } catch (error) {
            console.log('⚠️ Discord non connecté - continuation sans notifications');
        }
        
        // Démarrer le scalping
        await scalper.startScalping();
        
    } catch (error) {
        console.error('❌ Erreur scalper:', error.message);
    }
}

// EXPORT
module.exports = { SolanaScalper, testScalping, runScalper };

// EXÉCUTION DIRECTE
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.includes('--test')) {
        testScalping();
    } else if (args.includes('--run')) {
        runScalper();
    } else {
        console.log('🏃‍♂️ SCALPER SOLANA - Module Sub-Horaire');
        console.log('═'.repeat(50));
        console.log('Usage:');
        console.log('  node scalping_module.js --test   - Tester configuration');
        console.log('  node scalping_module.js --run    - Lancer scalping');
        console.log('');
        console.log('🎯 Stratégie Scalping:');
        console.log('  ⚡ Timeframes: 5min detection, 15min primary');
        console.log('  🎯 Targets: +3% (30%), +6% (50%), +12% (70%), +20% (90%)');
        console.log('  🛡️ Protections: -5% stop, -4% trailing, 45min max hold');
        console.log('  📊 Patterns: Breakout, Acceleration, Rebound, Volume Spike');
        console.log('');
        console.log('Variables .env requises:');
        console.log('  PRIVATE_KEY=... (clé wallet base58)');
        console.log('  DISCORD_TOKEN=... (optionnel)');
        console.log('  DISCORD_CHANNEL_ID=... (optionnel)');
    }
}