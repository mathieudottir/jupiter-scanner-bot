// coingecko_test.js - CoinGecko sans stablecoins + détection momentum

// Liste des stablecoins à exclure
const STABLECOINS = [
    'usdc', 'usdt', 'busd', 'dai', 'frax', 'lusd', 'susd', 'tusd', 'usdp', 'gusd',
    'husd', 'usdn', 'ust', 'ousd', 'usdd', 'usdk', 'ustc', 'tribe', 'val', 'eur',
    'usd-coin', 'tether', 'binance-usd', 'multi-collateral-dai', 'stasis-eurs',
    'jpyc', 'ceur', 'cusd', 'xsgd', 'usdx', 'reserve', 'dola', 'liquity-usd'
];

// Fonction pour détecter les stablecoins
function isStablecoin(token) {
    const symbol = token.symbol.toLowerCase();
    const name = token.name.toLowerCase();
    const id = token.id.toLowerCase();
    
    // Vérifier dans la liste des stablecoins connus
    if (STABLECOINS.includes(symbol) || STABLECOINS.includes(id)) {
        return true;
    }
    
    // Vérifier les patterns de stablecoins
    const stablePatterns = [
        /usd/i, /eur/i, /jpy/i, /stable/i, /pegged/i, /tether/i, /coin.*usd/i
    ];
    
    return stablePatterns.some(pattern => 
        pattern.test(symbol) || pattern.test(name) || pattern.test(id)
    );
}

// Fonction pour calculer le score de momentum
function calculateMomentumScore(token) {
    const change1h = token.price_change_percentage_1h_in_currency || 0;
    const change24h = token.price_change_percentage_24h || 0;
    const change7d = token.price_change_percentage_7d_in_currency || 0;
    const volume = token.total_volume || 0;
    const marketCap = token.market_cap || 0;
    
    // Score de momentum basé sur:
    // - Performance récente (1h et 24h plus importantes que 7d)
    // - Consistance du momentum (tous positifs = bonus)
    // - Volume relatif au market cap
    
    const momentumScore = 
        change1h * 3 +           // 1h = très important
        change24h * 2 +          // 24h = important  
        change7d * 0.5;          // 7d = contexte
    
    // Bonus si momentum consistant (tous positifs)
    const consistencyBonus = (change1h > 0 && change24h > 0 && change7d > 0) ? 20 : 0;
    
    // Score volume/market cap (activité relative)
    const volumeRatio = marketCap > 0 ? (volume / marketCap) * 100 : 0;
    const volumeScore = Math.min(volumeRatio * 10, 50); // Max 50 points
    
    return momentumScore + consistencyBonus + volumeScore;
}

async function testCoinGeckoWithMomentum() {
    console.log('🔍 COINGECKO - TOP SOLANA AVEC MOMENTUM');
    console.log('═'.repeat(60));
    
    try {
        let allTokens = [];
        
        // Récupérer plusieurs pages
        for (let page = 1; page <= 4; page++) {
            console.log(`\n📡 Récupération page ${page}...`);
            
            const response = await fetch(
                'https://api.coingecko.com/api/v3/coins/markets?' +
                `vs_currency=usd&` +
                `category=solana-ecosystem&` +
                `order=volume_desc&` +
                `per_page=50&` +
                `page=${page}&` +
                `sparkline=false&` +
                `price_change_percentage=1h,24h,7d`
            );
            
            if (response.ok) {
                const tokens = await response.json();
                console.log(`✅ ${tokens.length} tokens reçus`);
                allTokens.push(...tokens);
                
                // Rate limiting (50 appels/min gratuit)
                await new Promise(resolve => setTimeout(resolve, 1500));
            } else {
                console.log(`❌ Erreur page ${page}: ${response.status}`);
                if (response.status === 429) {
                    console.log('⏳ Rate limit - attente plus longue...');
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
                break;
            }
        }
        
        console.log(`\n📊 Total tokens collectés: ${allTokens.length}`);
        
        // Filtrer: enlever stablecoins + critères de base
        const filteredTokens = allTokens.filter(token => {
            const isStable = isStablecoin(token);
            const hasVolume = token.total_volume && token.total_volume > 50000; // Min 50k volume
            const hasPrice = token.current_price && token.current_price > 0;
            const hasData = token.price_change_percentage_24h !== null;
            
            if (isStable) {
                console.log(`🚫 Stablecoin exclu: ${token.symbol.toUpperCase()}`);
            }
            
            return !isStable && hasVolume && hasPrice && hasData;
        });
        
        console.log(`🔥 ${filteredTokens.length} tokens après filtrage (stablecoins exclus)`);
        
        // Calculer le momentum pour chaque token
        const tokensWithMomentum = filteredTokens.map(token => ({
            ...token,
            momentumScore: calculateMomentumScore(token)
        }));
        
        // 1. TOP VOLUME (référence)
        const topVolume = tokensWithMomentum
            .sort((a, b) => b.total_volume - a.total_volume)
            .slice(0, 15);
        
        console.log('\n📊 TOP 15 PAR VOLUME (référence):');
        topVolume.forEach((token, i) => {
            const change1h = token.price_change_percentage_1h_in_currency;
            const change24h = token.price_change_percentage_24h;
            
            console.log(`${i+1}. ${token.symbol.toUpperCase()} - Vol: ${token.total_volume.toLocaleString()} - 1h: ${change1h?.toFixed(1) || 'N/A'}% - 24h: ${change24h?.toFixed(1) || 'N/A'}%`);
        });
        
        // 2. TOP MOMENTUM
        const topMomentum = tokensWithMomentum
            .filter(token => {
                // Critères pour être considéré comme "momentum"
                const change1h = token.price_change_percentage_1h_in_currency || 0;
                const change24h = token.price_change_percentage_24h || 0;
                
                return change1h > 2 || change24h > 5; // Au moins +2% 1h OU +5% 24h
            })
            .sort((a, b) => b.momentumScore - a.momentumScore)
            .slice(0, 20);
        
        console.log('\n🚀 TOP 20 TOKENS AVEC MOMENTUM:');
        topMomentum.forEach((token, i) => {
            const change1h = token.price_change_percentage_1h_in_currency;
            const change24h = token.price_change_percentage_24h;
            const change7d = token.price_change_percentage_7d_in_currency;
            const volumeRatio = token.market_cap > 0 ? (token.total_volume / token.market_cap * 100) : 0;
            
            console.log(`\n${i+1}. ${token.symbol.toUpperCase()}`);
            console.log(`   🔥 Score Momentum: ${token.momentumScore.toFixed(1)}`);
            console.log(`   📊 Volume 24h: ${token.total_volume.toLocaleString()}`);
            console.log(`   💰 Market Cap: ${token.market_cap ? token.market_cap.toLocaleString() : 'N/A'}`);
            console.log(`   💵 Prix: ${token.current_price}`);
            console.log(`   📈 1h: ${change1h?.toFixed(2) || 'N/A'}% | 24h: ${change24h?.toFixed(2) || 'N/A'}% | 7d: ${change7d?.toFixed(2) || 'N/A'}%`);
            console.log(`   📊 Vol/MCap: ${volumeRatio.toFixed(2)}%`);
            console.log(`   🏷️  ${token.name}`);
            
            // Indicateur de type de momentum
            let momentumType = '';
            if (change1h > 5 && change24h > 10) momentumType = '🔥 HOT';
            else if (change1h > 0 && change24h > 0 && change7d > 0) momentumType = '📈 CONSISTENT';
            else if (change1h > 10) momentumType = '⚡ PUMP';
            else if (change24h > 20) momentumType = '🚀 BREAKOUT';
            else momentumType = '📊 TRENDING';
            
            console.log(`   🎯 Type: ${momentumType}`);
        });
        
        // 3. STATISTIQUES
        console.log('\n📊 STATISTIQUES MOMENTUM:');
        const positiveTokens = tokensWithMomentum.filter(t => (t.price_change_percentage_24h || 0) > 0);
        const strongMomentum = tokensWithMomentum.filter(t => t.momentumScore > 20);
        
        console.log(`   📈 Tokens en positif 24h: ${positiveTokens.length}/${tokensWithMomentum.length}`);
        console.log(`   🔥 Tokens momentum fort (>20): ${strongMomentum.length}`);
        console.log(`   🚫 Stablecoins exclus: ${allTokens.length - filteredTokens.length}`);
        
        return topMomentum;
        
    } catch (error) {
        console.error('❌ Erreur CoinGecko momentum:', error.message);
    }
}

// Version rapide - Top 10 momentum seulement
async function getTopMomentumTokens(limit = 10) {
    console.log('⚡ SCAN RAPIDE - TOP MOMENTUM SOLANA');
    console.log('═'.repeat(40));
    
    try {
        const response = await fetch(
            'https://api.coingecko.com/api/v3/coins/markets?' +
            'vs_currency=usd&' +
            'category=solana-ecosystem&' +
            'order=volume_desc&' +
            'per_page=100&' +
            'page=1&' +
            'sparkline=false&' +
            'price_change_percentage=1h,24h'
        );
        
        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }
        
        const tokens = await response.json();
        
        // Filtrer et scorer
        const momentumTokens = tokens
            .filter(token => 
                !isStablecoin(token) &&
                token.total_volume > 100000 &&
                token.current_price > 0 &&
                ((token.price_change_percentage_1h_in_currency || 0) > 3 ||
                 (token.price_change_percentage_24h || 0) > 8)
            )
            .map(token => ({
                ...token,
                momentumScore: calculateMomentumScore(token)
            }))
            .sort((a, b) => b.momentumScore - a.momentumScore)
            .slice(0, limit);
        
        console.log(`🎯 ${momentumTokens.length} tokens momentum trouvés:`);
        momentumTokens.forEach((token, i) => {
            console.log(`${i+1}. ${token.symbol.toUpperCase()} - Score: ${token.momentumScore.toFixed(1)} - 1h: ${token.price_change_percentage_1h_in_currency?.toFixed(1) || 'N/A'}% - 24h: ${token.price_change_percentage_24h?.toFixed(1) || 'N/A'}%`);
        });
        
        return momentumTokens;
        
    } catch (error) {
        console.error('❌ Erreur scan rapide:', error.message);
        return [];
    }
}

// Test si lancé directement
if (require.main === module) {
    console.log('🚀 Test CoinGecko avec momentum...');
    
    testCoinGeckoWithMomentum()
        .then(() => {
            console.log('\n' + '═'.repeat(60));
            return getTopMomentumTokens(10);
        })
        .then(() => {
            console.log('\n🎉 Terminé ! Tu as maintenant:');
            console.log('   ✅ Top tokens Solana SANS stablecoins');
            console.log('   ✅ Détection intelligente du momentum');
            console.log('   ✅ Score combiné: performance + volume + consistance');
            console.log('   ✅ 100% gratuit avec CoinGecko');
        })
        .catch(error => {
            console.error('❌ Erreur:', error);
        });
}

module.exports = { testCoinGeckoWithMomentum, getTopMomentumTokens, calculateMomentumScore, isStablecoin };