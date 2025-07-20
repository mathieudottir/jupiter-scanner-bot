// trade_logger.js - Module de logging et analytics des trades
const fs = require('fs').promises;
const path = require('path');

class TradeLogger {
    constructor() {
        this.logsDir = './logs';
        this.currentYear = new Date().getFullYear();
        this.tradesFile = path.join(this.logsDir, `trades_${this.currentYear}.json`);
        this.csvFile = path.join(this.logsDir, `trades_${this.currentYear}.csv`);
        this.analyticsFile = path.join(this.logsDir, 'analytics_summary.json');
        
        // Cache pour éviter les lectures répétées
        this.tradesCache = new Map();
        this.lastCacheUpdate = 0;
        this.cacheTimeout = 60000; // 1 minute
        
        this.initializeLogger();
    }

    // INITIALISATION
    async initializeLogger() {
        try {
            // Créer le dossier logs s'il n'existe pas
            await fs.mkdir(this.logsDir, { recursive: true });
            
            // Créer les fichiers s'ils n'existent pas
            await this.ensureFilesExist();
            
            console.log('📊 TradeLogger initialisé');
            console.log(`   📁 Logs: ${this.logsDir}`);
            console.log(`   📄 Trades: ${this.tradesFile}`);
            console.log(`   📊 CSV: ${this.csvFile}`);
            
        } catch (error) {
            console.error('❌ Erreur initialisation TradeLogger:', error.message);
        }
    }

    async ensureFilesExist() {
        // Fichier trades JSON
        try {
            await fs.access(this.tradesFile);
        } catch {
            await fs.writeFile(this.tradesFile, JSON.stringify({ trades: [], metadata: { version: '1.0', created: new Date().toISOString() } }, null, 2));
        }

        // Fichier analytics
        try {
            await fs.access(this.analyticsFile);
        } catch {
            const initialAnalytics = {
                summary: {
                    totalTrades: 0,
                    totalProfit: 0,
                    winRate: 0,
                    avgHoldTime: 0,
                    bestTrade: null,
                    worstTrade: null
                },
                patterns: {},
                lastUpdate: new Date().toISOString()
            };
            await fs.writeFile(this.analyticsFile, JSON.stringify(initialAnalytics, null, 2));
        }
    }

    // LOGGING D'UN TRADE COMPLET
    async logTrade(tradeData) {
        try {
            const trade = this.formatTradeData(tradeData);
            
            // Charger les trades existants
            const tradesData = await this.loadTrades();
            
            // Ajouter le nouveau trade
            tradesData.trades.push(trade);
            
            // Sauvegarder
            await fs.writeFile(this.tradesFile, JSON.stringify(tradesData, null, 2));
            
            // Mettre à jour le CSV
            await this.updateCSV(trade);
            
            // Mettre à jour les analytics si c'est une vente finale
            if (trade.type === 'SELL' || trade.type === 'COMPLETE_TRADE') {
                await this.updateAnalytics(trade);
            }
            
            console.log(`📝 Trade loggé: ${trade.tradeId} (${trade.type})`);
            
        } catch (error) {
            console.error('❌ Erreur logging trade:', error.message);
        }
    }

    // FORMATTING DES DONNÉES DE TRADE
    formatTradeData(data) {
        const now = new Date();
        const timestamp = data.timestamp || Date.now();
        const tradeDate = new Date(timestamp);
        
        const baseData = {
            tradeId: this.generateTradeId(data),
            type: data.type,
            timestamp: timestamp,
            date: tradeDate.toISOString(),
            dayOfWeek: this.getDayOfWeek(tradeDate),
            hour: tradeDate.getHours(),
            symbol: data.symbol,
            tokenAddress: data.tokenAddress
        };

        // Données spécifiques selon le type
        switch (data.type) {
            case 'BUY':
                return {
                    ...baseData,
                    buy: {
                        priceUSD: data.priceUSD || 0,
                        solInvested: data.solInvested || 0,
                        tokensReceived: data.tokensReceived || 0,
                        momentum1h: data.momentum1h || 0,
                        momentum24h: data.momentum24h || 0,
                        volume24h: data.volume24h || 0,
                        liquidityUSD: data.liquidityUSD || 0,
                        category: data.category || 'unknown',
                        confidence: data.confidence || 'MEDIUM',
                        reason: data.reason || 'Manual',
                        txHash: data.txHash || '',
                        slippage: data.slippage || 0,
                        marketConditions: {
                            activePositions: data.activePositions || 0,
                            sessionProfit: data.sessionProfit || 0,
                            hourlyVolume: data.hourlyVolume || 0
                        }
                    }
                };

            case 'PARTIAL_SELL':
                return {
                    ...baseData,
                    partialSell: {
                        priceUSD: data.priceUSD || 0,
                        solReceived: data.solReceived || 0,
                        profitSOL: data.profitSOL || 0,
                        profitPercent: data.profitPercent || 0,
                        percentage: data.percentage || 0,
                        reason: data.reason || '',
                        txHash: data.txHash || '',
                        currentHoldTime: data.currentHoldTime || 0
                    }
                };

            case 'SELL':
            case 'COMPLETE_TRADE':
                return {
                    ...baseData,
                    type: 'COMPLETE_TRADE',
                    buy: data.buyData || {},
                    sell: {
                        priceUSD: data.sellPriceUSD || 0,
                        solReceived: data.totalSolReceived || 0,
                        profitSOL: data.totalProfit || 0,
                        profitPercent: data.totalProfitPercent || 0,
                        duration: data.duration || 0,
                        durationMinutes: Math.round((data.duration || 0) / (1000 * 60)),
                        reason: data.exitReason || '',
                        partialSells: data.partialSells || 0,
                        highestPrice: data.highestPrice || 0,
                        highestPercent: data.highestPercent || 0,
                        txHashes: data.txHashes || []
                    },
                    performance: {
                        roi: data.totalProfitPercent || 0,
                        holdTime: this.formatDuration(data.duration || 0),
                        category: this.categorizePerformance(data.totalProfitPercent || 0),
                        grade: this.gradePerformance(data.totalProfitPercent || 0, data.duration || 0)
                    }
                };

            default:
                return baseData;
        }
    }

    // HELPERS
    generateTradeId(data) {
        const date = new Date(data.timestamp || Date.now());
        const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
        const timeStr = date.toTimeString().slice(0, 8).replace(/:/g, '');
        const symbol = (data.symbol || 'UNK').slice(0, 6);
        const random = Math.random().toString(36).slice(2, 5);
        
        return `${dateStr}_${timeStr}_${symbol}_${random}`;
    }

    getDayOfWeek(date) {
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        return days[date.getDay()];
    }

    formatDuration(ms) {
        const minutes = Math.floor(ms / (1000 * 60));
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        return `${minutes}m`;
    }

    categorizePerformance(profitPercent) {
        if (profitPercent >= 50) return 'excellent';
        if (profitPercent >= 20) return 'good';
        if (profitPercent >= 5) return 'decent';
        if (profitPercent >= -5) return 'neutral';
        if (profitPercent >= -20) return 'poor';
        return 'terrible';
    }

    gradePerformance(profitPercent, duration) {
        const hours = duration / (1000 * 60 * 60);
        
        // Grading basé sur profit ET efficacité temporelle
        if (profitPercent >= 100) return 'S+';
        if (profitPercent >= 50) return 'S';
        if (profitPercent >= 30) return 'A';
        if (profitPercent >= 15) return 'B';
        if (profitPercent >= 5) return 'C';
        if (profitPercent >= -5) return 'D';
        return 'F';
    }

    // CHARGEMENT DES TRADES
    async loadTrades() {
        try {
            const data = await fs.readFile(this.tradesFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error('❌ Erreur lecture trades:', error.message);
            return { trades: [], metadata: { version: '1.0', created: new Date().toISOString() } };
        }
    }

    // MISE À JOUR CSV
    async updateCSV(trade) {
        try {
            let csvContent = '';
            
            // Headers CSV
            const headers = [
                'Trade ID', 'Type', 'Date', 'Day', 'Hour', 'Symbol', 'Token Address',
                'Buy Price USD', 'SOL Invested', 'Tokens Received', 'Momentum 1h', 'Momentum 24h', 'Volume 24h', 'Liquidity USD',
                'Sell Price USD', 'SOL Received', 'Profit SOL', 'Profit %', 'Duration Min', 'Exit Reason',
                'Category', 'Confidence', 'Performance Grade', 'Active Positions'
            ];
            
            // Vérifier si le fichier existe
            let fileExists = false;
            try {
                await fs.access(this.csvFile);
                fileExists = true;
            } catch {
                csvContent = headers.join(',') + '\n';
            }
            
            // Formater les données du trade
            const row = [
                trade.tradeId || '',
                trade.type || '',
                trade.date || '',
                trade.dayOfWeek || '',
                trade.hour || '',
                trade.symbol || '',
                trade.tokenAddress || '',
                trade.buy?.priceUSD || '',
                trade.buy?.solInvested || '',
                trade.buy?.tokensReceived || '',
                trade.buy?.momentum1h || '',
                trade.buy?.momentum24h || '',
                trade.buy?.volume24h || '',
                trade.buy?.liquidityUSD || '',
                trade.sell?.priceUSD || '',
                trade.sell?.solReceived || '',
                trade.sell?.profitSOL || '',
                trade.sell?.profitPercent || '',
                trade.sell?.durationMinutes || '',
                trade.sell?.reason || '',
                trade.buy?.category || '',
                trade.buy?.confidence || '',
                trade.performance?.grade || '',
                trade.buy?.marketConditions?.activePositions || ''
            ];
            
            csvContent += row.map(field => `"${field}"`).join(',') + '\n';
            
            // Append au fichier
            await fs.appendFile(this.csvFile, csvContent);
            
        } catch (error) {
            console.error('❌ Erreur mise à jour CSV:', error.message);
        }
    }

    // ANALYTICS ET STATISTIQUES
    async updateAnalytics(trade) {
        try {
            const analytics = await this.loadAnalytics();
            
            // Mettre à jour les stats globales
            if (trade.type === 'COMPLETE_TRADE') {
                analytics.summary.totalTrades++;
                analytics.summary.totalProfit += trade.sell?.profitSOL || 0;
                
                const isWin = (trade.sell?.profitPercent || 0) > 0;
                analytics.summary.wins = (analytics.summary.wins || 0) + (isWin ? 1 : 0);
                analytics.summary.winRate = (analytics.summary.wins / analytics.summary.totalTrades) * 100;
                
                // Meilleur/pire trade
                if (!analytics.summary.bestTrade || (trade.sell?.profitPercent || 0) > analytics.summary.bestTrade.profitPercent) {
                    analytics.summary.bestTrade = {
                        tradeId: trade.tradeId,
                        symbol: trade.symbol,
                        profitPercent: trade.sell?.profitPercent || 0,
                        date: trade.date
                    };
                }
                
                if (!analytics.summary.worstTrade || (trade.sell?.profitPercent || 0) < analytics.summary.worstTrade.profitPercent) {
                    analytics.summary.worstTrade = {
                        tradeId: trade.tradeId,
                        symbol: trade.symbol,
                        profitPercent: trade.sell?.profitPercent || 0,
                        date: trade.date
                    };
                }
            }
            
            // Patterns par jour de la semaine
            if (!analytics.patterns.dayOfWeek) analytics.patterns.dayOfWeek = {};
            const day = trade.dayOfWeek;
            if (!analytics.patterns.dayOfWeek[day]) {
                analytics.patterns.dayOfWeek[day] = { trades: 0, profit: 0, wins: 0 };
            }
            analytics.patterns.dayOfWeek[day].trades++;
            analytics.patterns.dayOfWeek[day].profit += trade.sell?.profitSOL || 0;
            if ((trade.sell?.profitPercent || 0) > 0) {
                analytics.patterns.dayOfWeek[day].wins++;
            }
            
            // Patterns par heure
            if (!analytics.patterns.hourOfDay) analytics.patterns.hourOfDay = {};
            const hour = trade.hour;
            if (!analytics.patterns.hourOfDay[hour]) {
                analytics.patterns.hourOfDay[hour] = { trades: 0, profit: 0, wins: 0 };
            }
            analytics.patterns.hourOfDay[hour].trades++;
            analytics.patterns.hourOfDay[hour].profit += trade.sell?.profitSOL || 0;
            if ((trade.sell?.profitPercent || 0) > 0) {
                analytics.patterns.hourOfDay[hour].wins++;
            }
            
            // Patterns par token
            if (!analytics.patterns.tokens) analytics.patterns.tokens = {};
            const symbol = trade.symbol;
            if (!analytics.patterns.tokens[symbol]) {
                analytics.patterns.tokens[symbol] = { trades: 0, profit: 0, wins: 0, avgHoldTime: 0 };
            }
            analytics.patterns.tokens[symbol].trades++;
            analytics.patterns.tokens[symbol].profit += trade.sell?.profitSOL || 0;
            if ((trade.sell?.profitPercent || 0) > 0) {
                analytics.patterns.tokens[symbol].wins++;
            }
            
            analytics.lastUpdate = new Date().toISOString();
            
            // Sauvegarder
            await fs.writeFile(this.analyticsFile, JSON.stringify(analytics, null, 2));
            
        } catch (error) {
            console.error('❌ Erreur update analytics:', error.message);
        }
    }

    async loadAnalytics() {
        try {
            const data = await fs.readFile(this.analyticsFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            return {
                summary: { totalTrades: 0, totalProfit: 0, winRate: 0, wins: 0 },
                patterns: {},
                lastUpdate: new Date().toISOString()
            };
        }
    }

    // GÉNÉRATION DE RAPPORTS
    async generateDailyReport() {
        try {
            const trades = await this.loadTrades();
            const today = new Date().toISOString().slice(0, 10);
            
            const todayTrades = trades.trades.filter(trade => 
                trade.date && trade.date.slice(0, 10) === today
            );
            
            const report = {
                date: today,
                totalTrades: todayTrades.length,
                completedTrades: todayTrades.filter(t => t.type === 'COMPLETE_TRADE').length,
                totalProfit: todayTrades
                    .filter(t => t.type === 'COMPLETE_TRADE')
                    .reduce((sum, t) => sum + (t.sell?.profitSOL || 0), 0),
                winRate: this.calculateWinRate(todayTrades.filter(t => t.type === 'COMPLETE_TRADE')),
                tokens: [...new Set(todayTrades.map(t => t.symbol))],
                bestTrade: this.findBestTrade(todayTrades),
                worstTrade: this.findWorstTrade(todayTrades)
            };
            
            console.log('\n📊 RAPPORT JOURNALIER');
            console.log('═'.repeat(50));
            console.log(`📅 Date: ${report.date}`);
            console.log(`📈 Trades: ${report.completedTrades}/${report.totalTrades}`);
            console.log(`💰 Profit: ${report.totalProfit > 0 ? '+' : ''}${report.totalProfit.toFixed(4)} SOL`);
            console.log(`🏆 Win Rate: ${report.winRate.toFixed(1)}%`);
            console.log(`🪙 Tokens: ${report.tokens.join(', ')}`);
            
            if (report.bestTrade) {
                console.log(`🥇 Meilleur: ${report.bestTrade.symbol} (+${report.bestTrade.profitPercent.toFixed(1)}%)`);
            }
            
            if (report.worstTrade) {
                console.log(`🥉 Pire: ${report.worstTrade.symbol} (${report.worstTrade.profitPercent.toFixed(1)}%)`);
            }
            
            return report;
            
        } catch (error) {
            console.error('❌ Erreur génération rapport journalier:', error.message);
            return null;
        }
    }

    calculateWinRate(trades) {
        if (trades.length === 0) return 0;
        const wins = trades.filter(t => (t.sell?.profitPercent || 0) > 0).length;
        return (wins / trades.length) * 100;
    }

    findBestTrade(trades) {
        const completedTrades = trades.filter(t => t.type === 'COMPLETE_TRADE');
        if (completedTrades.length === 0) return null;
        
        return completedTrades.reduce((best, current) => {
            const currentProfit = current.sell?.profitPercent || 0;
            const bestProfit = best.sell?.profitPercent || 0;
            return currentProfit > bestProfit ? current : best;
        });
    }

    findWorstTrade(trades) {
        const completedTrades = trades.filter(t => t.type === 'COMPLETE_TRADE');
        if (completedTrades.length === 0) return null;
        
        return completedTrades.reduce((worst, current) => {
            const currentProfit = current.sell?.profitPercent || 0;
            const worstProfit = worst.sell?.profitPercent || 0;
            return currentProfit < worstProfit ? current : worst;
        });
    }

    // EXPORT AVANCÉ
    async exportAnalyticsToCSV() {
        try {
            const analytics = await this.loadAnalytics();
            
            let csvContent = 'Type,Category,Value,Trades,Profit,WinRate\n';
            
            // Par jour de la semaine
            if (analytics.patterns.dayOfWeek) {
                Object.entries(analytics.patterns.dayOfWeek).forEach(([day, data]) => {
                    const winRate = data.trades > 0 ? (data.wins / data.trades) * 100 : 0;
                    csvContent += `Day,${day},${day},${data.trades},${data.profit.toFixed(4)},${winRate.toFixed(1)}\n`;
                });
            }
            
            // Par heure
            if (analytics.patterns.hourOfDay) {
                Object.entries(analytics.patterns.hourOfDay).forEach(([hour, data]) => {
                    const winRate = data.trades > 0 ? (data.wins / data.trades) * 100 : 0;
                    csvContent += `Hour,${hour}h,${hour},${data.trades},${data.profit.toFixed(4)},${winRate.toFixed(1)}\n`;
                });
            }
            
            // Par token
            if (analytics.patterns.tokens) {
                Object.entries(analytics.patterns.tokens).forEach(([token, data]) => {
                    const winRate = data.trades > 0 ? (data.wins / data.trades) * 100 : 0;
                    csvContent += `Token,${token},${token},${data.trades},${data.profit.toFixed(4)},${winRate.toFixed(1)}\n`;
                });
            }
            
            const analyticsCSV = path.join(this.logsDir, 'analytics_patterns.csv');
            await fs.writeFile(analyticsCSV, csvContent);
            
            console.log(`📊 Analytics exportées: ${analyticsCSV}`);
            return analyticsCSV;
            
        } catch (error) {
            console.error('❌ Erreur export analytics CSV:', error.message);
            return null;
        }
    }

    // NETTOYAGE ET MAINTENANCE
    async cleanOldLogs(daysToKeep = 90) {
        try {
            const trades = await this.loadTrades();
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
            
            const filteredTrades = trades.trades.filter(trade => {
                const tradeDate = new Date(trade.date);
                return tradeDate >= cutoffDate;
            });
            
            if (filteredTrades.length < trades.trades.length) {
                trades.trades = filteredTrades;
                await fs.writeFile(this.tradesFile, JSON.stringify(trades, null, 2));
                
                const removed = trades.trades.length - filteredTrades.length;
                console.log(`🧹 Nettoyage: ${removed} anciens trades supprimés`);
            }
            
        } catch (error) {
            console.error('❌ Erreur nettoyage logs:', error.message);
        }
    }

    // OPTIMISATIONS DE STRATEGIE
    async getOptimizationInsights() {
        try {
            const analytics = await this.loadAnalytics();
            const trades = await this.loadTrades();
            
            const insights = {
                bestTimeToTrade: this.findBestTimeToTrade(analytics.patterns),
                mostProfitableTokens: this.findMostProfitableTokens(analytics.patterns),
                optimalHoldTime: this.calculateOptimalHoldTime(trades.trades),
                riskFactors: this.identifyRiskFactors(trades.trades),
                recommendations: []
            };
            
            // Générer recommandations
            insights.recommendations = this.generateRecommendations(insights, analytics);
            
            console.log('\n🧠 INSIGHTS STRATÉGIQUES');
            console.log('═'.repeat(50));
            
            if (insights.bestTimeToTrade) {
                console.log(`⏰ Meilleure heure: ${insights.bestTimeToTrade.hour}h (${insights.bestTimeToTrade.winRate.toFixed(1)}% win rate)`);
                console.log(`📅 Meilleur jour: ${insights.bestTimeToTrade.day} (${insights.bestTimeToTrade.dayWinRate.toFixed(1)}% win rate)`);
            }
            
            if (insights.mostProfitableTokens.length > 0) {
                console.log(`🏆 Top tokens: ${insights.mostProfitableTokens.slice(0, 3).map(t => `${t.symbol} (${t.winRate.toFixed(1)}%)`).join(', ')}`);
            }
            
            if (insights.optimalHoldTime) {
                console.log(`⏱️ Hold time optimal: ${insights.optimalHoldTime.range} (ROI moyen: ${insights.optimalHoldTime.avgROI.toFixed(1)}%)`);
            }
            
            console.log('\n💡 RECOMMANDATIONS:');
            insights.recommendations.forEach((rec, i) => {
                console.log(`   ${i + 1}. ${rec}`);
            });
            
            return insights;
            
        } catch (error) {
            console.error('❌ Erreur génération insights:', error.message);
            return null;
        }
    }

    findBestTimeToTrade(patterns) {
        if (!patterns.hourOfDay || !patterns.dayOfWeek) return null;
        
        // Meilleure heure
        const bestHour = Object.entries(patterns.hourOfDay)
            .filter(([hour, data]) => data.trades >= 3) // Minimum 3 trades pour être significatif
            .sort((a, b) => {
                const aWinRate = a[1].trades > 0 ? (a[1].wins / a[1].trades) : 0;
                const bWinRate = b[1].trades > 0 ? (b[1].wins / b[1].trades) : 0;
                return bWinRate - aWinRate;
            })[0];
        
        // Meilleur jour
        const bestDay = Object.entries(patterns.dayOfWeek)
            .filter(([day, data]) => data.trades >= 3)
            .sort((a, b) => {
                const aWinRate = a[1].trades > 0 ? (a[1].wins / a[1].trades) : 0;
                const bWinRate = b[1].trades > 0 ? (b[1].wins / b[1].trades) : 0;
                return bWinRate - aWinRate;
            })[0];
        
        return {
            hour: bestHour ? parseInt(bestHour[0]) : null,
            winRate: bestHour ? (bestHour[1].wins / bestHour[1].trades) * 100 : 0,
            day: bestDay ? bestDay[0] : null,
            dayWinRate: bestDay ? (bestDay[1].wins / bestDay[1].trades) * 100 : 0
        };
    }

    findMostProfitableTokens(patterns) {
        if (!patterns.tokens) return [];
        
        return Object.entries(patterns.tokens)
            .filter(([token, data]) => data.trades >= 2) // Minimum 2 trades
            .map(([token, data]) => ({
                symbol: token,
                trades: data.trades,
                profit: data.profit,
                winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
                avgProfit: data.profit / data.trades
            }))
            .sort((a, b) => b.winRate - a.winRate);
    }

    calculateOptimalHoldTime(trades) {
        const completedTrades = trades.filter(t => t.type === 'COMPLETE_TRADE' && t.sell?.durationMinutes);
        if (completedTrades.length < 5) return null;
        
        // Grouper par tranches de temps
        const timeRanges = {
            '0-30min': { trades: [], totalROI: 0 },
            '30min-2h': { trades: [], totalROI: 0 },
            '2h-6h': { trades: [], totalROI: 0 },
            '6h-24h': { trades: [], totalROI: 0 },
            '24h+': { trades: [], totalROI: 0 }
        };
        
        completedTrades.forEach(trade => {
            const minutes = trade.sell.durationMinutes;
            const roi = trade.sell.profitPercent || 0;
            
            if (minutes <= 30) {
                timeRanges['0-30min'].trades.push(trade);
                timeRanges['0-30min'].totalROI += roi;
            } else if (minutes <= 120) {
                timeRanges['30min-2h'].trades.push(trade);
                timeRanges['30min-2h'].totalROI += roi;
            } else if (minutes <= 360) {
                timeRanges['2h-6h'].trades.push(trade);
                timeRanges['2h-6h'].totalROI += roi;
            } else if (minutes <= 1440) {
                timeRanges['6h-24h'].trades.push(trade);
                timeRanges['6h-24h'].totalROI += roi;
            } else {
                timeRanges['24h+'].trades.push(trade);
                timeRanges['24h+'].totalROI += roi;
            }
        });
        
        // Trouver la meilleure tranche
        const bestRange = Object.entries(timeRanges)
            .filter(([range, data]) => data.trades.length >= 2)
            .map(([range, data]) => ({
                range,
                count: data.trades.length,
                avgROI: data.totalROI / data.trades.length
            }))
            .sort((a, b) => b.avgROI - a.avgROI)[0];
        
        return bestRange;
    }

    identifyRiskFactors(trades) {
        const completedTrades = trades.filter(t => t.type === 'COMPLETE_TRADE');
        const losses = completedTrades.filter(t => (t.sell?.profitPercent || 0) < -10);
        
        const riskFactors = {
            highLossReasons: {},
            dangerousTokens: {},
            badTimings: {}
        };
        
        // Analyser les raisons de grosses pertes
        losses.forEach(trade => {
            const reason = trade.sell?.reason || 'unknown';
            if (!riskFactors.highLossReasons[reason]) {
                riskFactors.highLossReasons[reason] = 0;
            }
            riskFactors.highLossReasons[reason]++;
            
            // Tokens dangereux
            const symbol = trade.symbol;
            if (!riskFactors.dangerousTokens[symbol]) {
                riskFactors.dangerousTokens[symbol] = 0;
            }
            riskFactors.dangerousTokens[symbol]++;
        });
        
        return riskFactors;
    }

    generateRecommendations(insights, analytics) {
        const recommendations = [];
        
        // Recommandations timing
        if (insights.bestTimeToTrade?.winRate > 70) {
            recommendations.push(`🕐 Concentrer les trades vers ${insights.bestTimeToTrade.hour}h (${insights.bestTimeToTrade.winRate.toFixed(1)}% success)`);
        }
        
        if (insights.bestTimeToTrade?.dayWinRate > 60) {
            recommendations.push(`📅 Privilégier les ${insights.bestTimeToTrade.day}s pour trader`);
        }
        
        // Recommandations tokens
        if (insights.mostProfitableTokens.length > 0) {
            const topToken = insights.mostProfitableTokens[0];
            if (topToken.winRate > 70) {
                recommendations.push(`🎯 Augmenter allocation sur ${topToken.symbol} (${topToken.winRate.toFixed(1)}% win rate)`);
            }
        }
        
        // Recommandations hold time
        if (insights.optimalHoldTime?.avgROI > 15) {
            recommendations.push(`⏱️ Optimiser les sorties dans la tranche ${insights.optimalHoldTime.range}`);
        }
        
        // Recommandations risk management
        const totalTrades = analytics.summary.totalTrades;
        const winRate = analytics.summary.winRate;
        
        if (winRate < 50 && totalTrades > 10) {
            recommendations.push(`⚠️ Revoir critères d'entrée (win rate: ${winRate.toFixed(1)}%)`);
        }
        
        if (totalTrades > 20 && analytics.summary.totalProfit < 0) {
            recommendations.push(`🛡️ Réduire taille positions ou resserrer stop-loss`);
        }
        
        return recommendations;
    }

    // MÉTHODES D'ACCÈS RAPIDE
    async getTradesBySymbol(symbol) {
        const trades = await this.loadTrades();
        return trades.trades.filter(t => t.symbol === symbol);
    }

    async getTradesByDate(dateStr) {
        const trades = await this.loadTrades();
        return trades.trades.filter(t => t.date && t.date.startsWith(dateStr));
    }

    async getRecentTrades(hours = 24) {
        const trades = await this.loadTrades();
        const cutoff = Date.now() - (hours * 60 * 60 * 1000);
        return trades.trades.filter(t => t.timestamp >= cutoff);
    }

    // DEBUGGING ET MAINTENANCE
    async validateLogFiles() {
        try {
            console.log('🔍 Validation des fichiers de logs...');
            
            // Vérifier le fichier principal
            const trades = await this.loadTrades();
            console.log(`📄 ${trades.trades.length} trades dans ${this.tradesFile}`);
            
            // Vérifier l'intégrité des données
            let errors = 0;
            trades.trades.forEach((trade, index) => {
                if (!trade.tradeId || !trade.timestamp || !trade.symbol) {
                    console.log(`❌ Trade ${index}: Données manquantes`);
                    errors++;
                }
            });
            
            // Vérifier les fichiers CSV
            try {
                await fs.access(this.csvFile);
                console.log(`✅ Fichier CSV accessible: ${this.csvFile}`);
            } catch {
                console.log(`⚠️ Fichier CSV introuvable: ${this.csvFile}`);
            }
            
            // Vérifier analytics
            const analytics = await this.loadAnalytics();
            console.log(`📊 Analytics: ${analytics.summary.totalTrades} trades traités`);
            
            console.log(`\n🎯 Validation terminée: ${errors} erreurs trouvées`);
            return errors === 0;
            
        } catch (error) {
            console.error('❌ Erreur validation:', error.message);
            return false;
        }
    }
}

module.exports = TradeLogger;