// simple_auto_trader.js - Auto-trader Jupiter avec ventes échelonnées et monitoring rapide
require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));


const STABLECOINS = [
    'usdc', 'usdt', 'busd', 'dai', 'frax', 'lusd', 'susd', 'tusd', 'usdp', 'gusd',
    'husd', 'usdn', 'ust', 'ousd', 'usdd', 'usdk', 'ustc', 'tribe', 'val', 'eur',
    'usd-coin', 'tether', 'binance-usd', 'multi-collateral-dai', 'stasis-eurs',
    'jpyc', 'ceur', 'cusd', 'xsgd', 'usdx', 'reserve', 'dola', 'liquity-usd'
];

function isStablecoin(token) {
    const symbol = token.symbol.toLowerCase();
    const name = token.name.toLowerCase();
    const id = token.id.toLowerCase();
    
    if (STABLECOINS.includes(symbol) || STABLECOINS.includes(id)) {
        return true;
    }
    
    const stablePatterns = [
        /usd/i, /eur/i, /jpy/i, /stable/i, /pegged/i, /tether/i, /coin.*usd/i
    ];
    
    return stablePatterns.some(pattern => 
        pattern.test(symbol) || pattern.test(name) || pattern.test(id)
    );
}

function calculateMomentumScore(token) {
    const change1h = token.price_change_percentage_1h_in_currency || 0;
    const change24h = token.price_change_percentage_24h || 0;
    const change7d = token.price_change_percentage_7d_in_currency || 0;
    const volume = token.total_volume || 0;
    const marketCap = token.market_cap || 0;
    
    const momentumScore = 
        change1h * 3 +           
        change24h * 2 +          
        change7d * 0.5;          
    
    const consistencyBonus = (change1h > 0 && change24h > 0 && change7d > 0) ? 20 : 0;
    const volumeRatio = marketCap > 0 ? (volume / marketCap) * 100 : 0;
    const volumeScore = Math.min(volumeRatio * 10, 50);
    
    return momentumScore + consistencyBonus + volumeScore;
}

class SimpleAutoTrader {
    constructor() {
        // Configuration Discord
        this.discordToken = process.env.DISCORD_TOKEN;
        this.channelId = process.env.DISCORD_CHANNEL_ID;
        this.client = new Client({ 
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] 
        });
        
        // Configuration Solana avec RPC premium/alternatif
        const rpcUrls = [
    'https://api.mainnet-beta.solana.com',
    'https://rpc.ankr.com/solana',
    'https://solana-api.projectserum.com',
    process.env.SOLANA_RPC_URL
].filter(url => url && !url.includes('undefined'));
        
        this.connection = new Connection(rpcUrls[0] || 'https://api.mainnet-beta.solana.com', {
    commitment: 'confirmed',
    wsEndpoint: false,  // ← AJOUTER CETTE LIGNE
    httpHeaders: {
        'User-Agent': 'Jupiter-Trader/1.0'
    }
});

// Et pareil pour les backup connections
this.backupConnections = rpcUrls.slice(1).map(url => 
    new Connection(url, { 
        commitment: 'confirmed',
        wsEndpoint: false  // ← AJOUTER CETTE LIGNE
    })
);  




this.bannedAddresses = new Set([
    // Exemple d'adresses à bannir
    'fESbUKjuMY6jzDH9VP8cy4p3pu2q5W2rK2XghVfNseP', // SOL (exemple)
    'BfvBXetGhUafks5V22vRBudaTYUqx9BkD4kx7z6bbonk', // USDC (exemple)
    // Ajoute tes adresses ici
]);

   this.stagnationExit = {
        enabled: true,
        maxHoldTime: 4 * 60 * 60 * 1000,    // 4 heures maximum
        stagnantTime: 2 * 60 * 60 * 1000,   // 2h si vraiment stagnant
        stagnantThreshold: 5,                // ±5% = stagnant
        lossExitTime: 90 * 60 * 1000,       // 1h30 si perte significative
        lossThreshold: -10                   // -10%
    };
    
    console.log(`⏰ Sortie stagnation: 4h max | 2h si ±5% | 1h30 si -10%`);

// Ou charger depuis un fichier
this.loadBannedAddresses();
        this.wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
        
        // Configuration trading
        this.buyAmount = 0.01; // Force à 0.01 SOL
        this.maxSlippage = parseFloat(process.env.MAX_SLIPPAGE || '10');
        
        // Rate limiting pour éviter 429
        this.lastRpcCall = 0;
        this.rpcCallDelay = 2000; // 1 seconde entre appels RPC
        this.balanceCache = new Map(); // Cache des soldes
        this.cacheTimeout = 60000; // 30 secondes de cache
        
        // Configuration ventes échelonnées
        this.sellLevels = [
            { 
                profit: 20,      // +20%
                percentage: 50,  // Vendre 50% de la position
                reason: "Sécurisation rapide (+20%)" 
            },
            { 
                profit: 75,      // +75% 
                percentage: 60,  // Vendre 60% du restant
                reason: "Take-Profit intermédiaire (+75%)" 
            },
            { 
                profit: 200,     // +200%
                percentage: 75,  // Vendre 75% du restant
                reason: "Take-Profit élevé (+200%)" 
            },
            { 
                profit: 500,     // +500%
                percentage: 90,  // Vendre 90% du restant
                reason: "Moonshot (+500%)" 
            }
        ];
        
        // Protections
        this.stopLossPercent = 20; // -20%
        this.useTrailingStop = true;
        this.trailingStopPercent = 15; // -15% depuis le plus haut
        
            this.maxConcurrentPositions = 2; // Maximum 2 positions simultanées
    this.coinGeckoCache = null; // Cache des tokens CoinGecko
    this.coinGeckoCacheTime = 0; // Timestamp du cache
    this.coinGeckoCacheTimeout = 5 * 60 * 1000; // 5 minutes
        // Positions actives
        this.positions = new Map(); // tokenAddress -> position data
        this.postedTokens = new Map(); // Anti-doublons
        this.retradeCooldown = {
        normal: 24 * 60 * 60 * 1000,        // 24h normal
        afterLoss: 48 * 60 * 60 * 1000,     // 48h si perte
        afterProfit: 12 * 60 * 60 * 1000,   // 12h si profit
        opportunityThreshold: 50,             // +50% momentum pour override
        minCooldownOverride: 6 * 60 * 60 * 1000  // Min 6h avant override
    };
        
        // Critères de filtrage (même que le scanner)
        this.maxAgeHours = 1;
        this.minLiquidity = 30000;
        this.minVolume = 10000;
        this.minChange = 20;
        this.tradedTokens = new Map(); // tokenAddress -> tradeHistory
    
        console.log(`🔄 Re-trade: 24h normal, 12h si profit, 48h si perte`);
        console.log(`⚡ Override possible si +50% momentum après 6h min`);
        console.log(`💼 Wallet: ${this.wallet.publicKey.toString()}`);
        console.log(`💰 Buy amount: ${this.buyAmount} SOL`);
        console.log(`🎯 Ventes échelonnées: ${this.sellLevels.length} niveaux`);
        console.log(`📉 Stop loss: -${this.stopLossPercent}%`);
        console.log(`📈 Trailing stop: -${this.trailingStopPercent}%`);
    }

    // Initialiser Discord
    async initializeDiscord() {
        try {
            console.log('🤖 Connexion à Discord...');
            await this.client.login(this.discordToken);
            
            this.client.once('ready', () => {
                console.log(`✅ Bot connecté: ${this.client.user.tag}`);
            });
            
            return true;
        } catch (error) {
            console.error('❌ Erreur connexion Discord:', error.message);
            return false;
        }
    }
    

    async confirmTransactionPolling(txid, maxRetries = 30) {
    console.log(`⏳ Confirmation transaction par polling: ${txid}`);
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            await this.waitForRateLimit();
            
            const status = await this.connection.getSignatureStatus(txid);
            
            if (status?.value?.confirmationStatus === 'confirmed' || 
                status?.value?.confirmationStatus === 'finalized') {
                console.log(`✅ Transaction confirmée en ${i + 1} tentatives`);
                return true;
            }
            
            if (status?.value?.err) {
                console.log(`❌ Transaction échouée: ${JSON.stringify(status.value.err)}`);
                return false;
            }
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
        } catch (error) {
            console.log(`⚠️ Erreur vérification ${i + 1}: ${error.message}`);
            if (i === maxRetries - 1) return false;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    return false;
}
    // Scanner les nouveaux tokens (même logique que le scanner)
// Scanner amélioré avec tokens récents ET performants
async scanNewTokens() {
    console.log('🔍 Scan CoinGecko - Top Momentum Solana...');
    
    try {
        // Vérifier le cache d'abord
        const now = Date.now();
        if (this.coinGeckoCache && 
            (now - this.coinGeckoCacheTime) < this.coinGeckoCacheTimeout) {
            console.log('💾 Utilisation cache CoinGecko');
            return this.coinGeckoCache;
        }
        
        console.log('📡 Récupération données CoinGecko...');
        const response = await fetch(
            'https://api.coingecko.com/api/v3/coins/markets?' +
            'vs_currency=usd&' +
            'category=solana-ecosystem&' +
            'order=volume_desc&' +
            'per_page=100&' +
            'page=1&' +
            'sparkline=false&' +
            'price_change_percentage=1h,24h,7d'
        );
        
        if (!response.ok) {
            console.log(`❌ Erreur CoinGecko API: ${response.status}`);
            return [];
        }
        
        const tokens = await response.json();
        console.log(`📊 ${tokens.length} tokens Solana reçus`);
        
        // Filtrer et scorer les tokens
        const momentumTokens = tokens
    .filter(token => {
        const isStable = isStablecoin(token);
        const hasVolume = token.total_volume && token.total_volume > 200000;
        const hasPrice = token.current_price > 0;
        
        const change1h = token.price_change_percentage_1h_in_currency || 0;
        const change24h = token.price_change_percentage_24h || 0;
        
        // FILTRE ULTRA-STRICT: Momentum récent OBLIGATOIRE
        const hasStrongRecentMomentum = 
            change1h > 3 &&        // +3% minimum sur 1h (récent)
            change24h > 10 &&      // +10% minimum sur 24h (contexte)
            change1h > 0;          // Double vérification 1h positif
        
        // Logging détaillé
        if (isStable) {
            console.log(`🚫 Stablecoin: ${token.symbol.toUpperCase()}`);
        } else if (change1h <= 0) {
            console.log(`❌ ${token.symbol.toUpperCase()}: 1h négatif (${change1h.toFixed(1)}%)`);
        } else if (change1h <= 3) {
            console.log(`⚠️ ${token.symbol.toUpperCase()}: 1h trop faible (+${change1h.toFixed(1)}%)`);
        } else if (change24h <= 10) {
            console.log(`⚠️ ${token.symbol.toUpperCase()}: 24h trop faible (+${change24h.toFixed(1)}%)`);
        }
        
        return !isStable && hasVolume && hasPrice && hasStrongRecentMomentum;
    })
            .map(token => ({
                ...token,
                momentumScore: calculateMomentumScore(token),
                // Convertir au format attendu par le trader
                baseToken: {
                    address: token.id, // On va chercher l'adresse Solana après
                    symbol: token.symbol.toUpperCase(),
                    name: token.name
                },
                priceUsd: token.current_price.toString(),
                volume: { h24: token.total_volume },
                priceChange: { 
                    h1: token.price_change_percentage_1h_in_currency,
                    h24: token.price_change_percentage_24h 
                },
                scanReason: this.getCoinGeckoScanReason(token)
            }))
            .sort((a, b) => {
    // 1. PRIORITÉ: Momentum 1h (plus c'est récent, plus c'est important)
    const momentum1hA = a.price_change_percentage_1h_in_currency || 0;
    const momentum1hB = b.price_change_percentage_1h_in_currency || 0;
    
    if (momentum1hA !== momentum1hB) {
        return momentum1hB - momentum1hA; // Plus fort momentum 1h en premier
    }
    
    // 2. En cas d'égalité, utiliser le score momentum global
    return b.momentumScore - a.momentumScore;
})
            .slice(0, 10); // Top 10 pour commencer
        
        console.log(`🎯 ${momentumTokens.length} tokens momentum trouvés:`);
        momentumTokens.forEach((token, i) => {
            const change1h = token.priceChange.h1;
            const change24h = token.priceChange.h24;
            console.log(`   ${i+1}. ${token.baseToken.symbol} - Score: ${token.momentumScore.toFixed(1)} - 1h: ${change1h?.toFixed(1) || 'N/A'}% - 24h: ${change24h?.toFixed(1) || 'N/A'}%`);
        });
        
        // Maintenant récupérer les adresses Solana réelles via DexScreener
        const tokensWithAddresses = await this.getCoinGeckoSolanaAddresses(momentumTokens);
        
        // Mettre en cache
        this.coinGeckoCache = tokensWithAddresses;
        this.coinGeckoCacheTime = now;
        
        return tokensWithAddresses;
        
    } catch (error) {
        console.error('❌ Erreur scan CoinGecko:', error.message);
        return [];
    }
}
checkStagnationExit(position) {
    if (!this.stagnationExit.enabled) return null;
    
    const now = Date.now();
    const holdTime = now - position.buyTime;
    const currentPrice = position.lastKnownPrice || position.buyPrice;
    const changePercent = ((currentPrice / position.buyPrice) - 1) * 100;
    
    // 1. TEMPS MAXIMUM (4h peu importe quoi)
    if (holdTime > this.stagnationExit.maxHoldTime) {
        return `⏰ Temps maximum (4h)`;
    }
    
    // 2. PERTE SIGNIFICATIVE TROP LONGUE (1h30 + perte > 10%)
    if (holdTime > this.stagnationExit.lossExitTime && 
        changePercent < this.stagnationExit.lossThreshold) {
        return `💸 Perte prolongée (${changePercent.toFixed(1)}% depuis 1h30+)`;
    }
    
    // 3. VRAIE STAGNATION (2h + mouvement < 5%)
    if (holdTime > this.stagnationExit.stagnantTime && 
        Math.abs(changePercent) < this.stagnationExit.stagnantThreshold) {
        return `😴 Stagnation totale (${changePercent.toFixed(1)}% en 2h+)`;
    }
    
    return null; // Pas de sortie
}

// Fonction helper pour identifier la raison du scan
getScanReason(token) {
    const age = this.calculateAge(token.pairCreatedAt);
    const liquidity = parseFloat(token.liquidity?.usd || 0);
    const change24h = parseFloat(token.priceChange?.h24 || 0);
    
    if (age <= 1) {
        return "🆕 Nouveau";
    } else if (liquidity >= 100000) {
        return "💎 Haute liquidité";
    } else if (change24h >= 50) {
        return "🚀 Très performant";
    } else {
        return "📈 Performant";
    }
}

    // Calculer l'âge du token
    calculateAge(createdAt) {
        if (!createdAt) return null;
        try {
            return (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
        } catch {
            return null;
        }
    }

    // Vérifier si un token a déjà été traité
   isTokenAlreadyProcessed(tokenAddress, currentMomentumScore = 0) {
    if (!this.tradedTokens.has(tokenAddress)) {
        return false; // Jamais tradé
    }
    
    const tradeHistory = this.tradedTokens.get(tokenAddress);
    const lastTrade = tradeHistory.lastTradeTime;
    const lastResult = tradeHistory.lastResult; // 'profit', 'loss', 'breakeven'
    const timeSinceLastTrade = Date.now() - lastTrade;
    
    // Déterminer le cooldown selon le résultat précédent
    let cooldownTime;
    if (lastResult === 'profit') {
        cooldownTime = this.retradeCooldown.afterProfit; // 12h
    } else if (lastResult === 'loss') {
        cooldownTime = this.retradeCooldown.afterLoss; // 48h
    } else {
        cooldownTime = this.retradeCooldown.normal; // 24h
    }
    
    // Si cooldown pas encore écoulé
    if (timeSinceLastTrade < cooldownTime) {
        
        // MAIS vérifier si on peut faire un override pour opportunité exceptionnelle
        const canOverride = this.canOverrideCooldown(tradeHistory, currentMomentumScore, timeSinceLastTrade);
        
        if (canOverride) {
            console.log(`⚡ Override cooldown ${tokenAddress.slice(0, 8)}... - Opportunité exceptionnelle (+${currentMomentumScore.toFixed(1)}%)`);
            return false; // Autoriser le trade
        }
        
        const remainingHours = ((cooldownTime - timeSinceLastTrade) / (1000 * 60 * 60)).toFixed(1);
        console.log(`⏳ ${tokenAddress.slice(0, 8)}... en cooldown (${remainingHours}h restantes - ${lastResult})`);
        return true; // Bloquer
    }
    
    // Cooldown écoulé, nettoyer l'historique
    this.tradedTokens.delete(tokenAddress);
    return false;
}

// Remplacer markTokenAsProcessed() par:
markTokenAsProcessed(tokenAddress, result = 'unknown') {
    this.tradedTokens.set(tokenAddress, {
        lastTradeTime: Date.now(),
        lastResult: result,
        tradeCount: (this.tradedTokens.get(tokenAddress)?.tradeCount || 0) + 1,
        lastMomentumScore: 0 // Sera mis à jour
    });
    
    console.log(`📝 Token marqué: ${tokenAddress.slice(0, 8)}... (${result})`);
}

    // Rate limiting pour RPC calls
    async waitForRateLimit() {
        const now = Date.now();
        const timeSinceLastCall = now - this.lastRpcCall;
        
        if (timeSinceLastCall < this.rpcCallDelay) {
            const waitTime = this.rpcCallDelay - timeSinceLastCall;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        this.lastRpcCall = Date.now();
    }

    // Obtenir une connexion avec failover
    async getConnection(attempt = 0) {
        if (attempt === 0) {
            return this.connection;
        } else if (attempt <= this.backupConnections.length) {
            return this.backupConnections[attempt - 1];
        } else {
            return this.connection; // Retour au principal
        }
    }
        canOverrideCooldown(tradeHistory, currentMomentumScore, timeSinceLastTrade) {
    // Conditions pour override:
    // 1. Au moins 6h depuis le dernier trade
    // 2. Momentum exceptionnel (+50%+)
    // 3. Pas si le dernier trade était une grosse perte récente
    
    // 1. Temps minimum
    if (timeSinceLastTrade < this.retradeCooldown.minCooldownOverride) {
        return false; // Pas assez de temps écoulé
    }
    
    // 2. Momentum exceptionnel
    if (currentMomentumScore < this.retradeCooldown.opportunityThreshold) {
        return false; // Pas assez exceptionnel
    }
    
    // 3. Protection contre les grosses pertes récentes
    if (tradeHistory.lastResult === 'loss' && timeSinceLastTrade < 24 * 60 * 60 * 1000) {
        return false; // Pas d'override dans les 24h après une perte
    }
    
    return true; // Override autorisé !
}
    // Vérifier le solde avec cache et rate limiting
    async checkWalletBalance(tokenMint, requiredAmount, useCache = true) {
        try {
            const cacheKey = `${tokenMint}_${this.wallet.publicKey.toString()}`;
            
            // Vérifier le cache d'abord
            if (useCache && this.balanceCache.has(cacheKey)) {
                const cached = this.balanceCache.get(cacheKey);
                if (Date.now() - cached.timestamp < this.cacheTimeout) {
                    console.log(`💾 Cache: ${tokenMint === 'So11111111111111111111111111111111111111112' ? 'SOL' : 'Token'} = ${cached.balance}`);
                    return cached.balance >= requiredAmount;
                }
            }

            // Rate limiting
            await this.waitForRateLimit();

            let balance;
            let attempts = 0;
            const maxAttempts = 3;

            while (attempts < maxAttempts) {
                try {
                    const connection = await this.getConnection(attempts);
                    
                    if (tokenMint === 'So11111111111111111111111111111111111111112') {
                        // SOL balance
                        const lamports = await connection.getBalance(this.wallet.publicKey);
                        balance = lamports / 1e9;
                        const requiredSol = requiredAmount / 1e9;
                        
                        console.log(`💰 Solde SOL: ${balance.toFixed(4)} | Requis: ${requiredSol.toFixed(4)}`);
                        
                        // Cache le résultat
                        this.balanceCache.set(cacheKey, { 
                            balance: lamports, 
                            timestamp: Date.now() 
                        });
                        
                        return balance >= requiredSol + 0.01; // +0.01 SOL pour les fees
                    } else {
                        // Token balance
                        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
                            this.wallet.publicKey,
                            { mint: new PublicKey(tokenMint) }
                        );
                        
                        if (tokenAccounts.value.length === 0) {
                            console.log(`❌ Aucun compte token trouvé pour ${tokenMint}`);
                            return false;
                        }
                        
                        balance = parseFloat(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
                        console.log(`💰 Solde token: ${balance} | Requis: ${requiredAmount}`);
                        
                        // Cache le résultat
                        this.balanceCache.set(cacheKey, { 
                            balance: balance, 
                            timestamp: Date.now() 
                        });
                        
                        return balance >= requiredAmount;
                    }
                } catch (rpcError) {
                    attempts++;
                    console.log(`⚠️ RPC Error attempt ${attempts}: ${rpcError.message}`);
                    
                    if (rpcError.message.includes('429') || rpcError.message.includes('Too Many Requests')) {
                        console.log(`🔄 Rate limit hit, waiting ${Math.pow(2, attempts)} seconds...`);
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
            async notifyPositionCheckSimple() {
    if (this.positions.size === 0) return;
    
    try {
        const channel = await this.client.channels.fetch(this.channelId);
        if (!channel) return;
        
        let message = `📊 **POSITIONS CHECK** (${this.positions.size})\n`;
        
        for (const [, position] of this.positions.entries()) {
            const currentPrice = position.lastKnownPrice || position.buyPrice;
            const changePercent = ((currentPrice / position.buyPrice) - 1) * 100;
            const holdTimeMin = ((Date.now() - position.buyTime) / (1000 * 60)).toFixed(0);
            
            const emoji = changePercent > 10 ? '🚀' : changePercent > 0 ? '📈' : changePercent > -10 ? '⚠️' : '🔴';
            const partialInfo = position.partialSells > 0 ? ` (${position.partialSells}x)` : '';
            
            message += `${emoji} **${position.symbol}**: ${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}% • ${holdTimeMin}min${partialInfo}\n`;
        }
        
        await channel.send(message);
        
    } catch (error) {
        console.error('❌ Erreur notification simple:', error.message);
    }
}
    // Tester la compatibilité Jupiter et obtenir un quote avec vérifications
   async getJupiterQuote(inputMint, outputMint, amount) {
    try {
        // Debug info pour moonshots
        const isLargeAmount = amount > 1000000000; // 1 milliard de tokens
        if (isLargeAmount) {
            console.log(`🚨 Gros montant détecté: ${amount.toLocaleString()} tokens`);
        }
        
        // Vérifier le solde avant de demander un quote
        const hasBalance = await this.checkWalletBalance(inputMint, amount);
        if (!hasBalance) {
            console.log(`❌ Solde insuffisant pour ${inputMint}`);
            return null;
        }

        console.log(`🔄 Jupiter quote: ${amount.toLocaleString()} tokens → SOL`);
        
        const response = await fetch(
            `https://quote-api.jup.ag/v6/quote?` +
            `inputMint=${inputMint}&` +
            `outputMint=${outputMint}&` +
            `amount=${amount}&` +
            `slippageBps=${this.maxSlippage * 100}&` +
            `onlyDirectRoutes=false&` +  // Permettre routes indirectes
            `asLegacyTransaction=false`, // Utiliser versioned transactions
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
                console.log(`❌ Jupiter quote error: ${quote.error}`);
                
                // Diagnostics spécifiques
                if (quote.error.includes('No routes found')) {
                    console.log(`🚫 Aucune route Jupiter trouvée - Token peut-être illiquide`);
                } else if (quote.error.includes('insufficient')) {
                    console.log(`🚫 Liquidité insuffisante sur Jupiter`);
                } else if (quote.error.includes('slippage')) {
                    console.log(`🚫 Slippage trop élevé - Token trop volatile`);
                }
                
                return null;
            }
            
            if (quote.outAmount && parseFloat(quote.outAmount) > 0) {
                const outAmount = parseFloat(quote.outAmount);
                const solAmount = outAmount / 1e9;
                console.log(`✅ Quote Jupiter: ${amount.toLocaleString()} → ${solAmount.toFixed(6)} SOL`);
                return quote;
            } else {
                console.log(`❌ Quote invalide: outAmount = ${quote.outAmount}`);
                return null;
            }
            
        } else {
            const errorText = await response.text();
            console.log(`❌ Jupiter API ${response.status}: ${errorText}`);
            
            // Diagnostics par code d'erreur
            if (response.status === 400) {
                console.log(`🔍 Erreur 400 possible causes:`);
                console.log(`   - Token non supporté par Jupiter`);
                console.log(`   - Montant invalide ou trop important`);
                console.log(`   - Adresse de token incorrecte`);
                console.log(`   - Token blacklisté/scam`);
            } else if (response.status === 429) {
                console.log(`🔍 Rate limit Jupiter - attendre`);
            }
            
            return null;
        }
        
    } catch (error) {
        console.log(`❌ Erreur Jupiter quote: ${error.message}`);
        return null;
    }
}
            async handleMoonshotSell(position, currentPrice, reason) {
    console.log(`🌙 Gestion vente moonshot: ${position.symbol} (+${((currentPrice/position.buyPrice-1)*100).toFixed(0)}%)`);
    
    // 1. ESSAYER VENTE TOTALE D'ABORD (plus simple que partielle)
    console.log(`🎯 Tentative vente totale moonshot...`);
    const totalSellSuccess = await this.sellEntirePosition(position, currentPrice, `Moonshot ${reason}`);
    
    if (totalSellSuccess) {
        console.log(`✅ Vente totale moonshot réussie !`);
        return true;
    }
    
    // 2. ESSAYER VENTE AVEC MONTANTS PLUS PETITS
    console.log(`🎯 Tentative vente par petits chunks...`);
    const chunkSuccess = await this.sellMoonshotInChunks(position, currentPrice);
    
    if (chunkSuccess) {
        return true;
    }
    
    // 3. MARQUER COMME PROBLÉMATIQUE ET CONTINUER À SURVEILLER
    console.log(`⚠️ Vente moonshot impossible - surveillance continue`);
    position.moonshotSellFailed = true;
    position.lastFailedSellTime = Date.now();
    
    return false;
}

// ==========================================
// 4. VENTE PAR CHUNKS POUR MOONSHOTS
// ==========================================

async sellMoonshotInChunks(position, currentPrice) {
    console.log(`🧩 Vente moonshot par chunks...`);
    
    try {
        const tokenMint = position.tokenAddress;
        
        // Obtenir le solde réel
        await this.waitForRateLimit();
        const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
            this.wallet.publicKey,
            { mint: new PublicKey(tokenMint) }
        );
        
        if (tokenAccounts.value.length === 0) {
            console.log(`❌ Pas de compte token pour chunks`);
            return false;
        }
        
        const totalBalance = parseFloat(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
        console.log(`💰 Balance totale: ${totalBalance.toLocaleString()}`);
        
        // Vendre par chunks de 10% max
        const chunkSize = Math.floor(totalBalance * 0.1); // 10% à la fois
        const maxChunks = 5; // Max 5 chunks = 50% du total
        let soldChunks = 0;
        let totalSolReceived = 0;
        
        for (let i = 0; i < maxChunks; i++) {
            console.log(`🧩 Chunk ${i+1}/${maxChunks}: ${chunkSize.toLocaleString()} tokens`);
            
            const quote = await this.getJupiterQuote(tokenMint, 'So11111111111111111111111111111111111111112', chunkSize);
            
            if (quote) {
                const txid = await this.executeSwap(quote);
                
                if (txid) {
                    const solReceived = parseFloat(quote.outAmount) / 1e9;
                    totalSolReceived += solReceived;
                    soldChunks++;
                    
                    console.log(`✅ Chunk ${i+1} vendu: ${solReceived.toFixed(4)} SOL`);
                    
                    // Mettre à jour la position
                    position.totalSolReceived = (position.totalSolReceived || 0) + solReceived;
                    position.partialSells++;
                    
                    // Délai entre chunks
                    await new Promise(resolve => setTimeout(resolve, 5000));
                } else {
                    console.log(`❌ Chunk ${i+1} échoué`);
                    break;
                }
            } else {
                console.log(`❌ Quote chunk ${i+1} impossible`);
                break;
            }
        }
        
        if (soldChunks > 0) {
            console.log(`✅ Moonshot chunks vendus: ${soldChunks}/${maxChunks} = ${totalSolReceived.toFixed(4)} SOL`);
            
            // Notification Discord pour vente partielle moonshot
            await this.notifyMoonshotChunkSell(position, soldChunks, totalSolReceived, currentPrice);
            
            return true;
        }
        
        return false;
        
    } catch (error) {
        console.error(`❌ Erreur vente chunks: ${error.message}`);
        return false;
    }
}

    // Exécuter un swap Jupiter avec gestion d'erreurs améliorée
    async executeSwap(quote) {
        try {
            console.log(`🔄 Exécution swap: ${quote.inputMint} → ${quote.outputMint}`);
            console.log(`   📊 Amount: ${quote.inAmount} → ${quote.outAmount}`);
            
            // Double vérification du solde juste avant le swap
            const hasBalance = await this.checkWalletBalance(quote.inputMint, parseFloat(quote.inAmount));
            if (!hasBalance) {
                console.log(`❌ Solde insuffisant au moment du swap`);
                return null;
            }

            // Obtenir la transaction
            const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    quoteResponse: quote,
                    userPublicKey: this.wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true, // Ajuster automatiquement les compute units
                    prioritizationFeeLamports: 'auto' // Fee automatique pour priorité
                })
            });
            
            if (!swapResponse.ok) {
                const errorText = await swapResponse.text();
                throw new Error(`Swap API error: ${swapResponse.status} - ${errorText}`);
            }
            
            const { swapTransaction } = await swapResponse.json();
            
            if (!swapTransaction) {
                throw new Error('Pas de transaction reçue de Jupiter');
            }
            
            // Désérialiser et signer la transaction
            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            
            // Signer la transaction
            transaction.sign([this.wallet]);
            
            console.log(`📤 Envoi de la transaction...`);
            
            // Envoyer la transaction avec retry
            let txid = null;
            let attempts = 0;
            const maxAttempts = 3;
            
            while (attempts < maxAttempts && !txid) {
                try {
                    attempts++;
                    console.log(`   Tentative ${attempts}/${maxAttempts}...`);
                    
                    txid = await this.connection.sendTransaction(transaction, {
                        preflightCommitment: 'confirmed',
                        maxRetries: 0, // Pas de retry automatique
                        skipPreflight: false // Garder la simulation
                    });
                    
                    if (txid) {
                        console.log(`✅ Transaction envoyée: ${txid}`);
                        break;
                    }
                } catch (sendError) {
                    console.log(`❌ Tentative ${attempts} échouée: ${sendError.message}`);
                    
                    // Si erreur de simulation, arrêter immédiatement
                    if (sendError.message.includes('simulation failed') || 
                        sendError.message.includes('insufficient funds')) {
                        console.log(`🛑 Erreur fatale détectée, arrêt des tentatives`);
                        throw sendError;
                    }
                    
                    // Attendre avant retry
                    if (attempts < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
            }
            
            if (!txid) {
                throw new Error(`Impossible d'envoyer la transaction après ${maxAttempts} tentatives`);
            }
            
            // Attendre la confirmation avec timeout
            console.log(`⏳ Attente confirmation...`);
            const confirmationStart = Date.now();
            const confirmationTimeout = 60000; // 60 secondes
            
            console.log(`⏳ Confirmation par polling...`);
const confirmed = await this.confirmTransactionPolling(txid);

if (confirmed) {
    console.log(`✅ Transaction confirmée: ${txid}`);
    return txid;
} else {
    console.log(`⚠️ Confirmation timeout, mais transaction peut être valide: ${txid}`);
    return txid;
}
            
        } catch (error) {
            console.error(`❌ Erreur swap détaillée: ${error.message}`);
            
            // Logging détaillé pour debug
            if (error.message.includes('simulation failed')) {
                console.error('🔍 Erreur de simulation - vérifiez:');
                console.error('   - Solde suffisant du wallet');
                console.error('   - Token account existe');
                console.error('   - Slippage pas trop restrictif');
                console.error('   - Pool avec liquidité suffisante');
            }
            
            return null;
        }
    }

    // Acheter un token
   
    // Acheter un token avec toutes les protections


    // Vérifier et exécuter les ventes échelonnées
    async checkStagedSells(position, changePercent, currentPrice) {
    // Détecter si c'est un moonshot (>1000%)
    const isMoonshot = changePercent > 1000;
    
    if (isMoonshot) {
        console.log(`🌙 MOONSHOT DÉTECTÉ: ${position.symbol} +${changePercent.toFixed(0)}%`);
        
        // Pour les moonshots, essayer vente spéciale
        if (!position.moonshotSellAttempted) {
            position.moonshotSellAttempted = true;
            
            const success = await this.handleMoonshotSell(position, currentPrice, `+${changePercent.toFixed(0)}%`);
            
            if (success) {
                return; // Sortir si vente réussie
            }
        }
        
        // Si vente moonshot a échoué, continuer avec ventes normales mais adaptées
    }
    
    // Vérifier chaque niveau de vente (normal ou adapté pour moonshot)
    for (const level of this.sellLevels) {
        if (changePercent >= level.profit && !position.sellsExecuted.includes(level.profit)) {
            
            const remainingAmount = position.currentAmount;
            let amountToSell = remainingAmount * (level.percentage / 100);
            
            // Pour moonshots, réduire les montants de vente
            if (isMoonshot) {
                amountToSell = Math.min(amountToSell, remainingAmount * 0.1); // Max 10% à la fois
                console.log(`🌙 Montant réduit pour moonshot: ${amountToSell.toLocaleString()}`);
            }
            
            if (amountToSell > 0) {
                console.log(`🎯 Déclenchement vente échelonnée: ${position.symbol} +${changePercent.toFixed(1)}%`);
                console.log(`   💰 Vendre ${level.percentage}% (${amountToSell.toLocaleString()} tokens)${isMoonshot ? ' [MOONSHOT MODE]' : ''}`);
                
                const success = await this.sellPartialPosition(position, amountToSell, level, currentPrice);
                
                if (success) {
                    position.sellsExecuted.push(level.profit);
                    position.currentAmount = remainingAmount - amountToSell;
                    
                    if (position.currentAmount <= position.buyAmount * 0.01) {
                        console.log(`✅ Position ${position.symbol} entièrement vendue`);
                        this.positions.delete(position.tokenAddress);
                        break;
                    }
                } else if (isMoonshot) {
                    // Pour moonshots, marquer comme exécuté même si échec (éviter spam)
                    console.log(`⚠️ Vente moonshot échouée, niveau marqué comme tenté`);
                    position.sellsExecuted.push(level.profit);
                }
            }
        }
    }
}       
        async buyToken(tokenAddress, tokenData) {
    try {
        console.log(`💰 Tentative d'achat: ${tokenData.baseToken.symbol}`);
        
        // 🛡️ PROTECTION 1: FAKE LIQUIDITY
        const volume24h = parseFloat(tokenData.volume?.h24 || 0);
        const liquidity = parseFloat(tokenData.liquidity?.usd || 0);
        
        // Vérifier ratio liquidité/volume suspect
        if (volume24h === 0 && liquidity > 100000) {
            console.log(`🚨 SKIP ${tokenData.baseToken.symbol}: Volume 0 mais liquidité $${liquidity.toLocaleString()} = suspect`);
            this.banAddress(tokenAddress, 'Zero volume with high liquidity');
            return false;
        }
        
        if (volume24h > 0 && (liquidity / volume24h) > 1000) {
            const ratio = (liquidity / volume24h).toFixed(0);
            console.log(`🚨 SKIP ${tokenData.baseToken.symbol}: Ratio liquidité/volume ${ratio}x trop élevé = suspect`);
            this.banAddress(tokenAddress, `Suspicious liquidity ratio: ${ratio}x`);
            return false;
        }
        
        console.log(`✅ ${tokenData.baseToken.symbol}: Liquidité validée (vol: $${volume24h.toLocaleString()}, liq: $${liquidity.toLocaleString()})`);
        
        // 🛡️ PROTECTION 2: TEST DE VENDABILITÉ
        const sellTest = await this.testTokenSellability(tokenAddress);
        if (!sellTest.canSell) {
            console.log(`🚨 SKIP ${tokenData.baseToken.symbol}: ${sellTest.reason}`);
            this.banAddress(tokenAddress, sellTest.reason);
            return false;
        }
        
        console.log(`✅ ${tokenData.baseToken.symbol}: Vendabilité confirmée`);
        
        // 💰 EXÉCUTION DE L'ACHAT
        const solAmount = this.buyAmount * 1e9; // Convertir en lamports
        const solMint = 'So11111111111111111111111111111111111111112';
        
        // Obtenir quote d'achat
        const buyQuote = await this.getJupiterQuote(solMint, tokenAddress, solAmount);
        
        if (!buyQuote) {
            console.log(`❌ Impossible d'obtenir quote pour ${tokenData.baseToken.symbol}`);
            return false;
        }
        
        // Exécuter l'achat
        const txid = await this.executeSwap(buyQuote);
        
        if (txid) {
            const tokenAmount = parseFloat(buyQuote.outAmount);
            const price = parseFloat(tokenData.priceUsd || 0);
            
            // Enregistrer la position
            const position = {
                tokenAddress,
                symbol: tokenData.baseToken.symbol,
                buyPrice: price,
                buyAmount: tokenAmount,
                currentAmount: tokenAmount,
                buyTxid: txid,
                buyTime: Date.now(),
                solSpent: this.buyAmount,
                sellsExecuted: [],
                totalSolReceived: 0,
                partialSells: 0,
                highestPrice: price,
                highestPercent: 0
            };
            
            this.positions.set(tokenAddress, position);
            
            console.log(`✅ Achat réussi: ${tokenData.baseToken.symbol}`);
            console.log(`   💰 Prix: $${price}`);
            console.log(`   🪙 Quantité: ${tokenAmount.toLocaleString()}`);
            console.log(`   🔗 TX: ${txid}`);
            
            // Notification Discord
            await this.notifyBuy(position, tokenData);
            
            return true;
        }
        
        return false;
    } catch (error) {
        console.error(`❌ Erreur achat ${tokenData.baseToken?.symbol}: ${error.message}`);
        return false;
    }
}
        async testTokenSellability(tokenAddress) {
    try {
        console.log(`   🧪 Test vendabilité...`);
        
        const solMint = 'So11111111111111111111111111111111111111112';
        const testBuyAmount = 0.001 * 1e9; // 0.001 SOL
        
        // Test quote achat
        const buyQuote = await this.getJupiterQuote(solMint, tokenAddress, testBuyAmount);
        if (!buyQuote) {
            return { canSell: false, reason: 'Aucune route d\'achat Jupiter' };
        }
        
        const tokensReceived = parseFloat(buyQuote.outAmount);
        console.log(`      📊 0.001 SOL → ${tokensReceived.toLocaleString()} tokens`);
        
        // Test quote vente (50% des tokens)
        const sellAmount = Math.floor(tokensReceived * 0.5);
        const sellQuote = await this.getJupiterQuote(tokenAddress, solMint, sellAmount);
        if (!sellQuote) {
            return { canSell: false, reason: 'Aucune route de vente Jupiter' };
        }
        
        const solBack = parseFloat(sellQuote.outAmount) / 1e9;
        const impactPercent = ((0.001 - solBack) / 0.001) * 100;
        
        console.log(`      📊 50% tokens → ${solBack.toFixed(6)} SOL (impact: ${impactPercent.toFixed(1)}%)`);
        
        // Vérifications
        if (impactPercent > 75) {
            return { canSell: false, reason: `Impact trop élevé: ${impactPercent.toFixed(1)}%` };
        }
        
        if (solBack < 0.0001) {
            return { canSell: false, reason: `Retour trop faible: ${solBack.toFixed(6)} SOL` };
        }
        
        console.log(`      ✅ Token vendable`);
        return { canSell: true, reason: 'Token vendable' };
        
    } catch (error) {
        console.log(`      ❌ Erreur test: ${error.message}`);
        return { canSell: false, reason: 'Erreur technique' };
    }
}
        async notifyMoonshotChunkSell(position, soldChunks, totalSolReceived, currentPrice) {
    try {
        const channel = await this.client.channels.fetch(this.channelId);
        if (!channel) return;
        
        const changePercent = ((currentPrice / position.buyPrice) - 1) * 100;
        
        const embed = new EmbedBuilder()
            .setColor(0xffd700) // Or pour moonshot
            .setTitle(`🌙 MOONSHOT PARTIEL - ${position.symbol}`)
            .setDescription(`**Vente par chunks réussie !**`)
            .addFields(
                {
                    name: '🚀 Performance',
                    value: `+${changePercent.toFixed(0)}%`,
                    inline: true
                },
                {
                    name: '🧩 Chunks vendus',
                    value: `${soldChunks}/5 chunks`,
                    inline: true
                },
                {
                    name: '💰 SOL reçu',
                    value: `${totalSolReceived.toFixed(4)} SOL`,
                    inline: true
                },
                {
                    name: '⚠️ Note',
                    value: 'Jupiter avait des difficultés avec ce moonshot, vente par petits montants réussie !',
                    inline: false
                }
            )
            .setFooter({ text: `Moonshot à ${new Date().toLocaleTimeString()}` })
            .setTimestamp();
        
        await channel.send({
            content: `🌙 **MOONSHOT ALERT** 🌙\n${position.symbol}: +${changePercent.toFixed(0)}% - Vente partielle réussie !`,
            embeds: [embed]
        });
        
    } catch (error) {
        console.error('❌ Erreur notification moonshot:', error.message);
    }
}
    // Vendre une partie de la position avec vérifications renforcées
    async sellPartialPosition(position, amountToSell, level, currentPrice) {
        try {
            console.log(`💸 Vente partielle: ${position.symbol} (${level.reason})`);
            console.log(`   🪙 Quantité à vendre: ${amountToSell.toLocaleString()}`);
            
            const tokenMint = position.tokenAddress;
            const solMint = 'So11111111111111111111111111111111111111112';
            
            // Arrondir la quantité pour éviter les erreurs de précision
            const roundedAmount = Math.floor(amountToSell);
            
            if (roundedAmount <= 0) {
                console.log(`❌ Quantité arrondie trop petite: ${roundedAmount}`);
                return false;
            }
            
            console.log(`   📊 Quantité arrondie: ${roundedAmount.toLocaleString()}`);
            
            // Vérifier qu'on a assez de tokens
            const hasTokens = await this.checkWalletBalance(tokenMint, roundedAmount);
            if (!hasTokens) {
                console.log(`❌ Pas assez de tokens pour la vente partielle`);
                return false;
            }
            
            // Obtenir quote de vente pour la quantité partielle
            const sellQuote = await this.getJupiterQuote(tokenMint, solMint, roundedAmount);
            
            if (!sellQuote) {
                console.log(`❌ Impossible d'obtenir quote de vente partielle pour ${position.symbol}`);
                return false;
            }
            
            console.log(`   💰 Quote reçu: ${roundedAmount} tokens → ${(parseFloat(sellQuote.outAmount) / 1e9).toFixed(4)} SOL`);
            
            // Exécuter la vente
            const txid = await this.executeSwap(sellQuote);
            
            if (txid) {
                const solReceived = parseFloat(sellQuote.outAmount) / 1e9;
                const partialProfit = solReceived - (position.solSpent * (level.percentage / 100));
                const partialProfitPercent = ((currentPrice / position.buyPrice) - 1) * 100;
                
                console.log(`✅ Vente partielle réussie: ${position.symbol}`);
                console.log(`   💰 SOL reçu: ${solReceived.toFixed(4)}`);
                console.log(`   📊 Profit partiel: ${partialProfit > 0 ? '+' : ''}${partialProfit.toFixed(4)} SOL`);
                console.log(`   🔗 TX: ${txid}`);
                
                // Notification Discord pour vente partielle
                await this.notifyPartialSell(position, solReceived, partialProfit, partialProfitPercent, level, txid);
                
                // Mettre à jour les statistiques de la position
                position.totalSolReceived += solReceived;
                position.partialSells += 1;
                
                return true;
            }
            
            return false;
        } catch (error) {
            console.error(`❌ Erreur vente partielle ${position.symbol}: ${error.message}`);
            return false;
        }
    }
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
    // Vendre toute la position restante avec vérifications renforcées

        // Vendre toute la position restante avec vérifications renforcées + tracking re-trade
async sellEntirePosition(position, currentPrice, reason) {
    try {
        console.log(`💸 Vente totale: ${position.symbol} (${reason})`);
        
        const tokenMint = position.tokenAddress;
        const solMint = 'So11111111111111111111111111111111111111112';
        
        // Obtenir le solde réel du wallet pour ce token
        await this.waitForRateLimit();
        const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
            this.wallet.publicKey,
            { mint: new PublicKey(tokenMint) }
        );
        
        if (tokenAccounts.value.length === 0) {
            console.log(`❌ Aucun compte token trouvé pour vente totale`);
            
            // Marquer comme échec mais supprimer la position
            this.markTokenAsProcessed(position.tokenAddress, 'loss');
            this.positions.delete(position.tokenAddress);
            return false;
        }
        
        const realBalance = parseFloat(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
        const amountToSell = Math.floor(realBalance * 0.99); // Garder 1% pour éviter les erreurs d'arrondi
        
        console.log(`   🪙 Solde réel: ${realBalance.toLocaleString()}`);
        console.log(`   🪙 Quantité à vendre: ${amountToSell.toLocaleString()}`);
        
        if (amountToSell <= 0) {
            console.log(`❌ Pas de tokens à vendre (solde: ${realBalance})`);
            
            // Position vide, la supprimer et marquer selon le contexte
            const tradeResult = position.totalSolReceived > 0 ? 'profit' : 'breakeven';
            this.markTokenAsProcessed(position.tokenAddress, tradeResult);
            this.positions.delete(position.tokenAddress);
            return false;
        }
        
        // Obtenir quote de vente pour tout le restant
        const sellQuote = await this.getJupiterQuote(tokenMint, solMint, amountToSell);
        
        if (!sellQuote) {
            console.log(`❌ Impossible d'obtenir quote de vente totale pour ${position.symbol}`);
            
            // Marquer comme échec technique mais garder la position pour retry
            console.log(`⚠️ Quote échoué, position gardée pour retry ultérieur`);
            return false;
        }
        
        const expectedSol = parseFloat(sellQuote.outAmount) / 1e9;
        console.log(`   💰 Quote reçu: ${amountToSell.toLocaleString()} tokens → ${expectedSol.toFixed(4)} SOL`);
        
        // Exécuter la vente
        const txid = await this.executeSwap(sellQuote);
        
        if (txid) {
            const solReceived = parseFloat(sellQuote.outAmount) / 1e9;
            const totalSolReceived = position.totalSolReceived + solReceived;
            const totalProfit = totalSolReceived - position.solSpent;
            const totalProfitPercent = ((totalSolReceived / position.solSpent) - 1) * 100;
            const holdTimeMin = ((Date.now() - position.buyTime) / (1000 * 60)).toFixed(0);
            
            console.log(`✅ Vente totale réussie: ${position.symbol}`);
            console.log(`   💰 SOL final reçu: ${solReceived.toFixed(4)} SOL`);
            console.log(`   💰 SOL total reçu: ${totalSolReceived.toFixed(4)} SOL`);
            console.log(`   📊 Profit total: ${totalProfit > 0 ? '+' : ''}${totalProfit.toFixed(4)} SOL (${totalProfitPercent > 0 ? '+' : ''}${totalProfitPercent.toFixed(1)}%)`);
            console.log(`   ⏱️ Durée position: ${holdTimeMin} minutes`);
            console.log(`   🎯 Ventes partielles: ${position.partialSells}`);
            console.log(`   🔗 TX finale: ${txid}`);
            
            // 🆕 DÉTERMINER LE RÉSULTAT POUR LE RE-TRADE SYSTEM
            let tradeResult;
            if (totalProfitPercent > 10) {
                tradeResult = 'profit';
                console.log(`🎉 Trade profitable: ${totalProfitPercent.toFixed(1)}% → Cooldown 12h`);
            } else if (totalProfitPercent < -5) {
                tradeResult = 'loss';
                console.log(`😞 Trade en perte: ${totalProfitPercent.toFixed(1)}% → Cooldown 48h`);
            } else {
                tradeResult = 'breakeven';
                console.log(`⚖️ Trade breakeven: ${totalProfitPercent.toFixed(1)}% → Cooldown 24h`);
            }
            
            // Mettre à jour l'historique de re-trade avec le résultat final
            this.markTokenAsProcessed(position.tokenAddress, tradeResult);
            
            // Stocker infos supplémentaires pour l'historique
            if (this.tradedTokens.has(position.tokenAddress)) {
                const history = this.tradedTokens.get(position.tokenAddress);
                history.finalProfit = totalProfitPercent;
                history.holdTimeMinutes = parseInt(holdTimeMin);
                history.partialSells = position.partialSells;
                history.exitReason = reason;
                history.totalSolReceived = totalSolReceived;
            }
            
            // Notification Discord pour vente finale
            await this.notifyFinalSell(position, totalSolReceived, totalProfit, totalProfitPercent, reason, txid);
            
            // Supprimer la position
            this.positions.delete(position.tokenAddress);
            
            // Invalider le cache de solde pour forcer refresh
            const cacheKey = `${solMint}_${this.wallet.publicKey.toString()}`;
            this.balanceCache.delete(cacheKey);
            
            console.log(`🗑️ Position ${position.symbol} fermée et supprimée`);
            
            return true;
            
        } else {
            console.log(`❌ Échec de la vente totale pour ${position.symbol}`);
            
            // En cas d'échec de vente, ne pas supprimer la position
            // Mais marquer dans l'historique pour éviter re-trade immédiat
            console.log(`⚠️ Vente échouée, position gardée pour retry`);
            
            // Marquer comme échec technique avec cooldown modéré
            this.markTokenAsProcessed(position.tokenAddress, 'loss');
            
            return false;
        }
        
    } catch (error) {
        console.error(`❌ Erreur vente totale ${position.symbol}: ${error.message}`);
        
        // Log détaillé pour debug
        console.error(`🔍 Détails erreur:`, {
            tokenAddress: position.tokenAddress,
            symbol: position.symbol,
            reason: reason,
            currentPrice: currentPrice,
            error: error.stack
        });
        
        // En cas d'erreur grave, marquer comme perte pour éviter re-trade rapide
        this.markTokenAsProcessed(position.tokenAddress, 'loss');
        
        // Ne pas supprimer la position en cas d'erreur technique
        // Elle sera retry au prochain cycle
        console.log(`⚠️ Erreur technique, position gardée pour retry`);
        
        return false;
    }
}
    // Notification Discord d'achat
    async notifyBuy(position, tokenData) {
        try {
            const channel = await this.client.channels.fetch(this.channelId);
            if (!channel) return;
            
            const embed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle(`🛒 ACHAT AUTOMATIQUE - ${position.symbol}`)
                .setDescription(`**Auto-trader a acheté ${tokenData.baseToken.name}**`)
                .addFields(
                    {
                        name: '💰 Prix d\'achat',
                        value: `$${position.buyPrice.toFixed(6)}`,
                        inline: true
                    },
                    {
                        name: '🪙 Quantité',
                        value: position.buyAmount.toLocaleString(),
                        inline: true
                    },
                    {
                        name: '💎 SOL dépensé',
                        value: `${position.solSpent} SOL`,
                        inline: true
                    },
                    {
                        name: '🎯 Ventes échelonnées',
                        value: `+20% (50%), +75% (60%), +200% (75%), +500% (90%)`,
                        inline: false
                    },
                    {
                        name: '🛡️ Protections',
                        value: `📉 Stop-Loss: -${this.stopLossPercent}%\n📈 Trailing: -${this.trailingStopPercent}%`,
                        inline: false
                    },
                    {
                        name: '📍 Adresse',
                        value: `\`${position.tokenAddress}\``,
                        inline: false
                    },
                    {
                        name: '🔗 Liens',
                        value: `[📊 DexScreener](${tokenData.url}) | [🔍 Solscan](https://solscan.io/tx/${position.buyTxid})`,
                        inline: false
                    }
                )
                .setFooter({ text: `Achat à ${new Date().toLocaleTimeString()}` })
                .setTimestamp();
            
            await channel.send({
                content: `🚨 **ACHAT AUTO** 🚨\n${position.symbol} acheté pour ${position.solSpent} SOL`,
                embeds: [embed]
            });
            
        } catch (error) {
            console.error('❌ Erreur notification achat:', error.message);
        }
    }
        async getCoinGeckoSolanaAddresses(coinGeckoTokens) {
    console.log('🔍 Recherche adresses Solana via DexScreener...');
    
    const tokensWithAddresses = [];
    
    for (const token of coinGeckoTokens.slice(0, 5)) { // Limiter à 5 pour éviter rate limit
        try {
            console.log(`   🔎 Recherche ${token.baseToken.symbol}...`);
            
            // Rechercher sur DexScreener par symbole
            const searchResponse = await fetch(
                `https://api.dexscreener.com/latest/dex/search?q=${token.baseToken.symbol}`
            );
            
            if (searchResponse.ok) {
                const searchData = await searchResponse.json();
                
                // Trouver une paire Solana correspondante
                const solanaPair = searchData.pairs?.find(pair => 
                    pair.chainId === 'solana' && 
                    pair.baseToken?.symbol?.toLowerCase() === token.baseToken.symbol.toLowerCase() &&
                    parseFloat(pair.liquidity?.usd || 0) > 50000 // Min 50k liquidité
                );
                
                if (solanaPair) {
                    // Ajouter l'adresse Solana trouvée
                    token.baseToken.address = solanaPair.baseToken.address;
                    token.liquidity = solanaPair.liquidity;
                    token.pairAddress = solanaPair.pairAddress;
                    token.url = solanaPair.url;
                    
                    tokensWithAddresses.push(token);
                    console.log(`   ✅ ${token.baseToken.symbol}: ${solanaPair.baseToken.address.slice(0, 8)}...`);
                } else {
                    console.log(`   ❌ ${token.baseToken.symbol}: Pas d'adresse Solana trouvée`);
                }
            }
            
            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));
            
        } catch (error) {
            console.log(`   ⚠️ Erreur ${token.baseToken.symbol}: ${error.message}`);
        }
    }
    
    console.log(`✅ ${tokensWithAddresses.length} tokens avec adresses Solana`);
    return tokensWithAddresses;
}

// Ajouter cette méthode helper:
getCoinGeckoScanReason(token) {
    const change1h = token.price_change_percentage_1h_in_currency || 0;
    const change24h = token.price_change_percentage_24h || 0;
    const volume = token.total_volume || 0;
    
    if (change1h > 10 && change24h > 20) return "🔥 Hot Momentum";
    if (change1h > 0 && change24h > 0) return "📈 Consistent Growth";
    if (change1h > 15) return "⚡ Pump Detected";
    if (change24h > 25) return "🚀 Breakout";
    if (volume > 1000000) return "💎 High Volume";
    return "📊 CoinGecko Trending";
}
    // Notification Discord pour vente partielle
    async notifyPartialSell(position, solReceived, profit, profitPercent, level, txid) {
        try {
            const channel = await this.client.channels.fetch(this.channelId);
            if (!channel) return;
            
            const embed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle(`💰 VENTE PARTIELLE - ${position.symbol}`)
                .setDescription(`**${level.reason}** - ${level.percentage}% vendu`)
                .addFields(
                    {
                        name: '💰 SOL reçu (partiel)',
                        value: `${solReceived.toFixed(4)} SOL`,
                        inline: true
                    },
                    {
                        name: '📈 Performance',
                        value: `+${profitPercent.toFixed(1)}%`,
                        inline: true
                    },
                    {
                        name: '🪙 Restant',
                        value: `${(100 - level.percentage).toFixed(0)}%`,
                        inline: true
                    },
                    {
                        name: '📊 Ventes effectuées',
                        value: `${position.partialSells + 1} niveaux`,
                        inline: true
                    },
                    {
                        name: '⏱️ Durée position',
                        value: `${((Date.now() - position.buyTime) / (1000 * 60)).toFixed(0)} min`,
                        inline: true
                    },
                    {
                        name: '🔗 Transaction',
                        value: `[🔍 Solscan](https://solscan.io/tx/${txid})`,
                        inline: false
                    }
                )
                .setFooter({ text: `Vente partielle à ${new Date().toLocaleTimeString()}` })
                .setTimestamp();
            
            await channel.send({
                content: `💰 **VENTE PARTIELLE** 💰\n${position.symbol}: ${level.percentage}% vendu à +${profitPercent.toFixed(1)}%`,
                embeds: [embed]
            });
            
        } catch (error) {
            console.error('❌ Erreur notification vente partielle:', error.message);
        }
    }

    // Notification Discord pour vente finale
    async notifyFinalSell(position, totalSolReceived, totalProfit, totalProfitPercent, reason, txid) {
        try {
            const channel = await this.client.channels.fetch(this.channelId);
            if (!channel) return;
            
            const isProfit = totalProfit > 0;
            const color = isProfit ? 0x00ff00 : 0xff0000;
            const emoji = isProfit ? '🎉' : '😢';
            
            const embed = new EmbedBuilder()
                .setColor(color)
                .setTitle(`🏁 POSITION FERMÉE - ${position.symbol}`)
                .setDescription(`**${reason}**`)
                .addFields(
                    {
                        name: '💰 SOL total reçu',
                        value: `${totalSolReceived.toFixed(4)} SOL`,
                        inline: true
                    },
                    {
                        name: `${emoji} Profit/Perte total`,
                        value: `${totalProfit > 0 ? '+' : ''}${totalProfit.toFixed(4)} SOL`,
                        inline: true
                    },
                    {
                        name: '📊 Performance totale',
                        value: `${totalProfitPercent > 0 ? '+' : ''}${totalProfitPercent.toFixed(1)}%`,
                        inline: true
                    },
                    {
                        name: '🎯 Ventes échelonnées',
                        value: `${position.partialSells} niveaux + finale`,
                        inline: true
                    },
                    {
                        name: '📈 Plus haut atteint',
                        value: `+${position.highestPercent.toFixed(1)}%`,
                        inline: true
                    },
                    {
                        name: '⏱️ Durée totale',
                        value: `${((Date.now() - position.buyTime) / (1000 * 60)).toFixed(0)} minutes`,
                        inline: true
                    },
                    {
                        name: '🔗 Transaction finale',
                        value: `[🔍 Solscan](https://solscan.io/tx/${txid})`,
                        inline: false
                    }
                )
                .setFooter({ text: `Position fermée à ${new Date().toLocaleTimeString()}` })
                .setTimestamp();
            
            await channel.send({
                content: `${isProfit ? '🎉' : '😢'} **POSITION FERMÉE** ${isProfit ? '🎉' : '😢'}\n${position.symbol}: ${totalProfitPercent > 0 ? '+' : ''}${totalProfitPercent.toFixed(1)}% total`,
                embeds: [embed]
            });
            
        } catch (error) {
            console.error('❌ Erreur notification vente finale:', error.message);
        }
    }

    // Traiter les nouveaux tokens
    async processNewTokens(tokens) {
    console.log(`🔄 Traitement de ${tokens.length} tokens CoinGecko...`);
    
    // Vérifier qu'on n'a pas déjà le maximum de positions
    if (this.positions.size >= this.maxConcurrentPositions) {
        console.log(`⏸️ Maximum de positions atteint (${this.maxConcurrentPositions})`);
        return 0;
    }
    
    let boughtCount = 0;
    const maxToBuy = this.maxConcurrentPositions - this.positions.size;
    
    for (const tokenData of tokens.slice(0, maxToBuy * 2)) { // Essayer 2x plus que nécessaire
        try {
            const tokenAddress = tokenData.baseToken?.address;
            if (!tokenAddress) continue;
            
            if (this.isAddressBanned(tokenAddress)) {
                console.log(`🚫 Token banni ignoré: ${tokenData.baseToken.symbol}`);
                continue;
            }
            
            if (this.isTokenAlreadyProcessed(tokenAddress, tokenData.momentumScore || 0)) {
                console.log(`⏭️ Token déjà traité: ${tokenData.baseToken.symbol}`);
                continue;
            }
            
            if (this.positions.has(tokenAddress)) {
                console.log(`⏭️ Position déjà ouverte: ${tokenData.baseToken.symbol}`);
                continue;
            }
            
            console.log(`🎯 Tentative achat: ${tokenData.baseToken.symbol} (${tokenData.scanReason})`);
            const bought = await this.buyToken(tokenAddress, tokenData);
            
            if (bought) {
                this.markTokenAsProcessed(tokenAddress);
                boughtCount++;
                console.log(`✅ Achat réussi ${boughtCount}/${maxToBuy}: ${tokenData.baseToken.symbol}`);
                
                if (boughtCount >= maxToBuy) {
                    console.log('✅ Quota d\'achats atteint pour ce cycle');
                    break;
                }
            } else {
                console.log(`❌ Échec achat: ${tokenData.baseToken.symbol}`);
            }
            
            await new Promise(resolve => setTimeout(resolve, 3000));
            
        } catch (error) {
            console.error(`❌ Erreur traitement token: ${error.message}`);
        }
    }
    
    console.log(`✅ ${boughtCount} nouveaux achats CoinGecko`);
    return boughtCount;
}
    // Fonction principale de scan et trading
    async runTradingCycle() {
        console.log('\n🤖 CYCLE DE TRADING AUTO');
        console.log('═'.repeat(50));
        
        try {
            // 1. Vérifier les positions existantes CHAQUE MINUTE
            if (this.positions.size > 0) {
                await this.checkPositions();
            }
            
            // 2. Scanner les nouveaux tokens (moins fréquent)
            const tokens = await this.scanNewTokens();
            
            if (tokens.length > 0) {
                // 3. Traiter les nouveaux tokens
                await this.processNewTokens(tokens);
            } else {
                console.log('⚠️ Aucun nouveau token trouvé');
            }
            
            // 4. Statistiques
            console.log(`\n📊 Positions actives: ${this.positions.size}`);
            if (this.positions.size > 0) {
                for (const [, position] of this.positions) {
                    const duration = ((Date.now() - position.buyTime) / (1000 * 60)).toFixed(0);
                    const profit = ((position.totalSolReceived + (position.currentAmount / position.buyAmount * position.solSpent)) / position.solSpent - 1) * 100;
                    console.log(`   💎 ${position.symbol}: ${duration}min, ${profit > 0 ? '+' : ''}${profit.toFixed(1)}%, ${position.partialSells} ventes`);
                }
            }
            
            return true;
            
        } catch (error) {
            console.error('❌ Erreur cycle trading:', error.message);
            return false;
        }
    }
    // Charger les adresses bannies depuis un fichier
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

// Vérifier si une adresse est bannie
isAddressBanned(tokenAddress) {
    return this.bannedAddresses.has(tokenAddress);
}

// Ajouter une adresse à la liste des bannies
banAddress(tokenAddress, reason = 'Manual ban') {
    this.bannedAddresses.add(tokenAddress);
    console.log(`🚫 Adresse bannie: ${tokenAddress} (${reason})`);
    
    // Sauvegarder dans le fichier
    this.saveBannedAddresses();
}

// Sauvegarder les adresses bannies
saveBannedAddresses() {
    try {
        const fs = require('fs');
        const content = Array.from(this.bannedAddresses).join('\n');
        fs.writeFileSync('./banned_addresses.txt', content);
    } catch (error) {
        console.log('⚠️ Erreur sauvegarde banned_addresses.txt:', error.message);
    }
}
    // Lancer le trading automatique avec double timing
async startAutoTrading() {
    console.log(`🚀 Démarrage Auto-Trading CoinGecko avec ventes échelonnées`);
    console.log(`💼 Wallet: ${this.wallet.publicKey.toString()}`);
    console.log(`💰 Montant par achat: ${this.buyAmount} SOL`);
    console.log(`🎯 Max positions simultanées: ${this.maxConcurrentPositions}`);
    console.log(`🔍 Source: CoinGecko Solana Momentum`);
    console.log(`⏰ Check positions: Toutes les 2 minutes`);
    console.log(`📊 Scan CoinGecko: Toutes les 10 minutes`);
    console.log('💡 Appuyez sur Ctrl+C pour arrêter\n');
    console.log(`⏰ Sortie stagnation: 4h max, 2h si stagne, 1h30 si -10%`);
    let scanCount = 0;
    
    // Timer positions (2 minutes)
    const positionCheckTimer = setInterval(async () => {
        try {
            if (this.positions.size > 0) {
                console.log(`\n⏰ ${new Date().toLocaleTimeString()} - Check ${this.positions.size} positions`);
                await this.checkPositions();
                
                // Si une position se ferme et qu'on est sous le max, relancer un scan
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
    
    // Timer scan CoinGecko (10 minutes) 
    const scanTimer = setInterval(async () => {
        try {
            scanCount++;
            console.log(`\n⏰ ${new Date().toLocaleTimeString()} - Scan CoinGecko #${scanCount}`);
            
            const tokens = await this.scanNewTokens();
            if (tokens.length > 0) {
                await this.processNewTokens(tokens);
            }
            
            console.log(`📊 Positions: ${this.positions.size}/${this.maxConcurrentPositions}`);
            if (scanCount % 3 === 0) { // Toutes les 3 scans (30min)
    this.showActiveCooldowns();
}
        } catch (error) {
            console.error('❌ Erreur scan CoinGecko:', error.message);
        }
    }, 10 * 60 * 1000);
    
    // Scan initial
    try {
        console.log(`\n⏰ ${new Date().toLocaleString()} - Scan initial CoinGecko`);
        const tokens = await this.scanNewTokens();
        if (tokens.length > 0) {
            await this.processNewTokens(tokens);
        }
    } catch (error) {
        console.error('❌ Erreur scan initial:', error.message);
    }
    
    // ... rest of existing code (SIGINT handler, while loop) ...
}
}

// Fonctions d'utilisation
async function runAutoTrader() {
    console.log('🤖 Auto-Trader Jupiter - Ventes Échelonnées');
    console.log('═'.repeat(60));
    
    const trader = new SimpleAutoTrader();
    
    try {
        // Initialiser Discord
        const isConnected = await trader.initializeDiscord();
        if (!isConnected) {
            console.log('❌ Impossible de se connecter à Discord');
            return;
        }
        
        // Attendre la connexion
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Vérifier le solde
        const balance = await trader.connection.getBalance(trader.wallet.publicKey);
        const solBalance = balance / 1e9;
        
        console.log(`💰 Solde wallet: ${solBalance.toFixed(4)} SOL`);
        
        if (solBalance < trader.buyAmount * 2) {
            console.log(`⚠️ Solde insuffisant pour trader (minimum: ${trader.buyAmount * 2} SOL)`);
            return;
        }
        
        // Lancer l'auto-trading avec double timing
        await trader.startAutoTrading();
        
    } catch (error) {
        console.error('❌ Erreur:', error.message);
    }
}

async function testTrader() {
    console.log('🧪 Test Auto-Trader...');
    
    const trader = new SimpleAutoTrader();
    
    try {
        // Test connexions
        await trader.initializeDiscord();
        console.log('✅ Discord OK');
        
        const balance = await trader.connection.getBalance(trader.wallet.publicKey);
        console.log(`✅ Solana OK - Balance: ${(balance / 1e9).toFixed(4)} SOL`);
        
        // Test scan
        const tokens = await trader.scanNewTokens();
        console.log(`✅ Scan OK - ${tokens.length} tokens trouvés`);
        
        console.log('\n🎯 Configuration ventes échelonnées:');
        trader.sellLevels.forEach((level, i) => {
            console.log(`   ${i + 1}. +${level.profit}% → Vendre ${level.percentage}% (${level.reason})`);
        });
        
        console.log(`\n🛡️ Protections:`);
        console.log(`   📉 Stop-Loss: -${trader.stopLossPercent}%`);
        console.log(`   📈 Trailing Stop: -${trader.trailingStopPercent}%`);
        console.log(`   ⏰ Check positions: Toutes les minutes`);
        console.log(`   🔍 Scan tokens: Toutes les 5 minutes`);
        
        console.log('\n🎉 Tous les tests réussis !');
        
    } catch (error) {
        console.error('❌ Erreur test:', error.message);
    }
}

module.exports = { SimpleAutoTrader, runAutoTrader, testTrader };

// Exécution si lancé directement
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
        
        runAutoTrader();
    }
}
// À la toute fin du fichier, après le module.exports
// Serveur web simple pour satisfaire Render
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Route de santé
app.get('/', (req, res) => {
    res.json({
        status: 'Bot Jupiter Scanner actif! 🚀',
        uptime: process.uptime(),
        lastScan: new Date().toISOString()
    });
});

// Statistiques du bot
app.get('/stats', (req, res) => {
    res.json({
        bot: 'Jupiter Scanner',
        status: 'running',
        scans: 'Toutes les 15 minutes'
    });
});

// Démarrer le serveur
app.listen(port, '0.0.0.0', () => {
    console.log(`🌐 Serveur web actif sur port ${port}`);
});