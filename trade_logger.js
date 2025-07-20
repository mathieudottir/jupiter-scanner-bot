// trade_logger.js - Module de logging et analytics des trades

const fs = require('fs').promises;
const path = require('path');
const nodemailer = require('nodemailer'); // ← Doit être ICI, pas dans le constructeur

class TradeLogger {
    constructor() {
        this.logsDir = './logs';
        this.currentYear = new Date().getFullYear();
        this.tradesFile = path.join(this.logsDir, `trades_${this.currentYear}.json`);
        this.csvFile = path.join(this.logsDir, `trades_${this.currentYear}.csv`);
        this.analyticsFile = path.join(this.logsDir, 'analytics_summary.json');

        // Configuration email backup
        this.emailConfig = {
            enabled: process.env.EMAIL_BACKUP === 'true',
            service: process.env.EMAIL_SERVICE || 'gmail',
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
            to: process.env.EMAIL_TO
        };
        
        // AJOUTEZ ces lignes de debug dans le constructeur
        console.log('🔍 DEBUG CONFIG:');
        console.log('   enabled:', this.emailConfig.enabled);
        console.log('   user:', this.emailConfig.user);
        console.log('   pass:', this.emailConfig.pass);
        console.log('   condition complète:', this.emailConfig.enabled && this.emailConfig.user && this.emailConfig.pass);
        
        // Initialiser le transporteur email
        if (this.emailConfig.enabled && this.emailConfig.user && this.emailConfig.pass) {
            try {
                console.log(`📧 Configuration email:`);
                console.log(`   Service: ${this.emailConfig.service}`);
                console.log(`   User: ${this.emailConfig.user}`);
                console.log(`   To: ${this.emailConfig.to}`);
                
                // FIX: Utiliser createTransport (pas createTransporter)
                this.emailTransporter = nodemailer.createTransport({
                    host: 'smtp.mail.yahoo.com',
                    port: 587,
                    secure: false,
                    auth: {
                        user: this.emailConfig.user,
                        pass: this.emailConfig.pass
                    },
                    tls: {
                        rejectUnauthorized: false
                    }
                });
                
                console.log(`📧 Email backup activé: ${this.emailConfig.to}`);
                
                // Test de connexion
                this.emailTransporter.verify((error, success) => {
                    if (error) {
                        console.log('❌ Erreur config email:', error.message);
                        this.emailConfig.enabled = false;
                    } else {
                        console.log('✅ Email transporteur prêt');
                        this.setupEmailBackupTimers();
                    }
                });
                
            } catch (error) {
                console.log('❌ Erreur init email:', error.message);
                this.emailConfig.enabled = false;
            }

        } else {
            console.log('📧 Email backup désactivé - Variables manquantes:');
            console.log(`   EMAIL_BACKUP: ${process.env.EMAIL_BACKUP}`);
            console.log(`   EMAIL_SERVICE: ${process.env.EMAIL_SERVICE}`);
            console.log(`   EMAIL_USER: ${process.env.EMAIL_USER}`);
            console.log(`   EMAIL_PASS: ${process.env.EMAIL_PASS ? 'SET' : 'MISSING'}`);
            console.log(`   EMAIL_TO: ${process.env.EMAIL_TO}`);
        }
        
        // Cache pour éviter les lectures répétées
        this.tradesCache = new Map();
        this.lastCacheUpdate = 0;
        this.cacheTimeout = 60000; // 1 minute
        
        this.initializeLogger();
    }

    // MÉTHODES EMAIL BACKUP
    setupEmailBackupTimers() {
        console.log('⏰ Configuration des timers email...');
        
        // Timer backup quotidien (23h50)
        this.dailyBackupTimer = setInterval(async () => {
            const now = new Date();
            if (now.getHours() === 23 && now.getMinutes() >= 50 && now.getMinutes() < 55) {
                await this.sendDailyEmailBackup();
            }
        }, 5 * 60 * 1000);
        
        // Timer backup si beaucoup de trades (toutes les heures)
        this.emergencyBackupTimer = setInterval(async () => {
            try {
                const recentTrades = await this.getRecentTrades(1);
                if (recentTrades.length >= 5) {
                    await this.sendEmergencyBackup(`${recentTrades.length} trades en 1h`);
                }
            } catch (error) {
                console.log('⚠️ Erreur check emergency backup:', error.message);
            }
        }, 60 * 60 * 1000);
        
        console.log('✅ Timers email configurés');
    }

    async sendDailyEmailBackup() {
        if (!this.emailConfig.enabled || !this.emailTransporter) {
            console.log('📧 Email backup désactivé');
            return;
        }
        
        try {
            console.log('📧 Préparation du backup quotidien...');
            
            const today = new Date().toISOString().slice(0, 10);
            const todayTrades = await this.getTradesByDate(today);
            const analytics = await this.loadAnalytics();
            
            const completedTrades = todayTrades.filter(t => 
                t.type === 'COMPLETE_TRADE' || t.type === 'SELL'
            );
            
            // Générer CSV du jour
            let csvContent = 'TradeID,Symbol,Date,Heure,SOL_Investi,SOL_Recu,Profit_Pourcent,Duree_Min,Raison_Sortie,Categorie\n';
            
            completedTrades.forEach(trade => {
                const date = new Date(trade.timestamp || trade.date);
                csvContent += [
                    trade.tradeId || '',
                    trade.symbol || '',
                    date.toISOString().slice(0, 10),
                    date.toTimeString().slice(0, 5),
                    trade.buyData?.solInvested || trade.buy?.solInvested || '',
                    trade.totalSolReceived || trade.sell?.solReceived || '',
                    (trade.totalProfitPercent || trade.sell?.profitPercent || 0).toFixed(2),
                    trade.sell?.durationMinutes || '',
                    trade.exitReason || trade.sell?.reason || '',
                    trade.buyData?.category || trade.buy?.category || ''
                ].map(f => `"${f}"`).join(',') + '\n';
            });
            
            // Calculer les stats du jour
            const wins = completedTrades.filter(t => (t.totalProfitPercent || t.sell?.profitPercent || 0) > 0).length;
            const winRate = completedTrades.length > 0 ? (wins / completedTrades.length * 100).toFixed(1) : '0';
            const totalProfit = completedTrades.reduce((sum, t) => sum + (t.totalProfit || t.sell?.profitSOL || 0), 0);
            const totalInvested = completedTrades.reduce((sum, t) => sum + (t.buyData?.solInvested || t.buy?.solInvested || 0), 0);
            const roi = totalInvested > 0 ? ((totalProfit / totalInvested) * 100).toFixed(1) : '0';
            
            // Rapport texte
            const report = `
🤖 JUPITER AUTO-TRADER - RAPPORT QUOTIDIEN
═══════════════════════════════════════════════════════════

📅 DATE: ${today}
🕐 GÉNÉRÉ: ${new Date().toLocaleString('fr-FR')}

📊 PERFORMANCE DU JOUR:
━━━━━━━━━━━━━━━━━━━━━━━━
• Trades complétés: ${completedTrades.length}
• Trades gagnants: ${wins}
• Win Rate: ${winRate}%
• SOL investi: ${totalInvested.toFixed(4)} SOL
• Profit/Perte: ${totalProfit > 0 ? '+' : ''}${totalProfit.toFixed(4)} SOL
• ROI du jour: ${roi > 0 ? '+' : ''}${roi}%

🏆 TOP 5 TRADES DU JOUR:
━━━━━━━━━━━━━━━━━━━━━━━━
${completedTrades
    .sort((a, b) => (b.totalProfitPercent || b.sell?.profitPercent || 0) - (a.totalProfitPercent || a.sell?.profitPercent || 0))
    .slice(0, 5)
    .map((t, i) => {
        const profit = (t.totalProfitPercent || t.sell?.profitPercent || 0);
        const duration = t.sell?.durationMinutes || 0;
        const emoji = profit > 20 ? '🚀' : profit > 0 ? '📈' : '📉';
        return `${i+1}. ${emoji} ${t.symbol}: ${profit > 0 ? '+' : ''}${profit.toFixed(1)}% (${duration}min)`;
    })
    .join('\n') || 'Aucun trade complété aujourd\'hui'}

📊 STATISTIQUES GLOBALES:
━━━━━━━━━━━━━━━━━━━━━━━━━━
• Total trades: ${analytics.summary.totalTrades}
• Win rate global: ${analytics.summary.winRate.toFixed(1)}%
• Profit total: ${analytics.summary.totalProfit > 0 ? '+' : ''}${analytics.summary.totalProfit.toFixed(4)} SOL

Generated by Jupiter Auto-Trader - ${new Date().toISOString()}
            `;
            
            // Envoyer l'email
            await this.emailTransporter.sendMail({
                from: this.emailConfig.user,
                to: this.emailConfig.to,
                subject: `🤖 Jupiter Bot - Rapport ${today} (${completedTrades.length} trades, ${winRate}% WR)`,
                text: report,
                attachments: [
                    {
                        filename: `jupiter_trades_${today}.csv`,
                        content: csvContent,
                        contentType: 'text/csv'
                    }
                ]
            });
            
            console.log(`✅ Backup quotidien envoyé: ${completedTrades.length} trades`);
            
        } catch (error) {
            console.error('❌ Erreur backup email quotidien:', error.message);
        }
    }

    async sendEmergencyBackup(reason) {
        if (!this.emailConfig.enabled || !this.emailTransporter) return;
        
        try {
            console.log(`🚨 Backup d'urgence: ${reason}`);
            
            const recentTrades = await this.getRecentTrades(2);
            const analytics = await this.loadAnalytics();
            
            let csvContent = 'TradeID,Symbol,Type,Date,Profit%\n';
            recentTrades.forEach(trade => {
                csvContent += [
                    trade.tradeId || '',
                    trade.symbol || '',
                    trade.type,
                    new Date(trade.timestamp || trade.date).toISOString(),
                    (trade.totalProfitPercent || trade.sell?.profitPercent || 0).toFixed(2)
                ].map(f => `"${f}"`).join(',') + '\n';
            });
            
            const report = `
🚨 BACKUP D'URGENCE - Jupiter Auto-Trader

Raison: ${reason}
Timestamp: ${new Date().toLocaleString('fr-FR')}

Trades récents (2h): ${recentTrades.length}
Total trades: ${analytics.summary.totalTrades}
Profit total: ${analytics.summary.totalProfit.toFixed(4)} SOL

Voir CSV attaché pour le détail.
            `;
            
            await this.emailTransporter.sendMail({
                from: this.emailConfig.user,
                to: this.emailConfig.to,
                subject: `🚨 Jupiter Bot - Backup urgence (${reason})`,
                text: report,
                attachments: [
                    {
                        filename: `jupiter_emergency_${Date.now()}.csv`,
                        content: csvContent,
                        contentType: 'text/csv'
                    }
                ]
            });
            
            console.log(`✅ Backup d'urgence envoyé`);
            
        } catch (error) {
            console.error('❌ Erreur backup urgence:', error.message);
        }
    }

    async sendManualBackup() {
        await this.sendDailyEmailBackup();
    }

    async testEmailConnection() {
        if (!this.emailConfig.enabled || !this.emailTransporter) {
            console.log('❌ Email non configuré');
            return false;
        }
        
        try {
            console.log('🧪 Test de connexion email...');
            
            await this.emailTransporter.verify();
            console.log('✅ Connexion email OK');
            
            await this.emailTransporter.sendMail({
                from: this.emailConfig.user,
                to: this.emailConfig.to,
                subject: '🧪 Test Jupiter Bot',
                text: `Test de connexion email réussi !\n\nConfiguration:\n- Service: ${this.emailConfig.service}\n- From: ${this.emailConfig.user}\n- To: ${this.emailConfig.to}\n\nTimestamp: ${new Date().toLocaleString()}`
            });
            
            console.log('✅ Email de test envoyé !');
            return true;
            
        } catch (error) {
            console.error('❌ Erreur test email:', error.message);
            return false;
        }
    }

    // INITIALISATION
    async initializeLogger() {
        try {
            await fs.mkdir(this.logsDir, { recursive: true });
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
        try {
            await fs.access(this.tradesFile);
        } catch {
            await fs.writeFile(this.tradesFile, JSON.stringify({ trades: [], metadata: { version: '1.0', created: new Date().toISOString() } }, null, 2));
        }

        try {
            await fs.access(this.analyticsFile);
        } catch {
            const initialAnalytics = {
                summary: { totalTrades: 0, totalProfit: 0, winRate: 0, avgHoldTime: 0, bestTrade: null, worstTrade: null },
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
            const tradesData = await this.loadTrades();
            tradesData.trades.push(trade);
            await fs.writeFile(this.tradesFile, JSON.stringify(tradesData, null, 2));
            await this.updateCSV(trade);
            
            if (trade.type === 'SELL' || trade.type === 'COMPLETE_TRADE') {
                await this.updateAnalytics(trade);
            }
            
            console.log(`📝 Trade loggé: ${trade.tradeId} (${trade.type})`);
            
        } catch (error) {
            console.error('❌ Erreur logging trade:', error.message);
        }
    }

    formatTradeData(data) {
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
                        marketConditions: {
                            activePositions: data.activePositions || 0,
                            sessionProfit: data.sessionProfit || 0
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
        if (profitPercent >= 100) return 'S+';
        if (profitPercent >= 50) return 'S';
        if (profitPercent >= 30) return 'A';
        if (profitPercent >= 15) return 'B';
        if (profitPercent >= 5) return 'C';
        if (profitPercent >= -5) return 'D';
        return 'F';
    }

    async loadTrades() {
        try {
            const data = await fs.readFile(this.tradesFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            return { trades: [], metadata: { version: '1.0', created: new Date().toISOString() } };
        }
    }

    async updateCSV(trade) {
        try {
            let csvContent = '';
            const headers = [
                'Trade ID', 'Type', 'Date', 'Day', 'Hour', 'Symbol', 'Token Address',
                'Buy Price USD', 'SOL Invested', 'Tokens Received', 'Momentum 1h', 'Momentum 24h', 'Volume 24h', 'Liquidity USD',
                'Sell Price USD', 'SOL Received', 'Profit SOL', 'Profit %', 'Duration Min', 'Exit Reason',
                'Category', 'Confidence', 'Performance Grade', 'Active Positions'
            ];
            
            try {
                await fs.access(this.csvFile);
            } catch {
                csvContent = headers.join(',') + '\n';
            }
            
            const row = [
                trade.tradeId || '', trade.type || '', trade.date || '', trade.dayOfWeek || '', trade.hour || '',
                trade.symbol || '', trade.tokenAddress || '', trade.buy?.priceUSD || '', trade.buy?.solInvested || '',
                trade.buy?.tokensReceived || '', trade.buy?.momentum1h || '', trade.buy?.momentum24h || '',
                trade.buy?.volume24h || '', trade.buy?.liquidityUSD || '', trade.sell?.priceUSD || '',
                trade.sell?.solReceived || '', trade.sell?.profitSOL || '', trade.sell?.profitPercent || '',
                trade.sell?.durationMinutes || '', trade.sell?.reason || '', trade.buy?.category || '',
                trade.buy?.confidence || '', trade.performance?.grade || '', trade.buy?.marketConditions?.activePositions || ''
            ];
            
            csvContent += row.map(field => `"${field}"`).join(',') + '\n';
            await fs.appendFile(this.csvFile, csvContent);
            
        } catch (error) {
            console.error('❌ Erreur mise à jour CSV:', error.message);
        }
    }

    async updateAnalytics(trade) {
        try {
            const analytics = await this.loadAnalytics();
            
            if (trade.type === 'COMPLETE_TRADE') {
                analytics.summary.totalTrades++;
                analytics.summary.totalProfit += trade.sell?.profitSOL || 0;
                
                const isWin = (trade.sell?.profitPercent || 0) > 0;
                analytics.summary.wins = (analytics.summary.wins || 0) + (isWin ? 1 : 0);
                analytics.summary.winRate = (analytics.summary.wins / analytics.summary.totalTrades) * 100;
            }
            
            analytics.lastUpdate = new Date().toISOString();
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

    async getTradesByDate(dateStr) {
        const trades = await this.loadTrades();
        return trades.trades.filter(t => t.date && t.date.startsWith(dateStr));
    }

    async getRecentTrades(hours = 24) {
        const trades = await this.loadTrades();
        const cutoff = Date.now() - (hours * 60 * 60 * 1000);
        return trades.trades.filter(t => t.timestamp >= cutoff);
    }

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
                tokens: [...new Set(todayTrades.map(t => t.symbol))]
            };
            
            console.log('\n📊 RAPPORT JOURNALIER');
            console.log('═'.repeat(50));
            console.log(`📅 Date: ${report.date}`);
            console.log(`📈 Trades: ${report.completedTrades}/${report.totalTrades}`);
            console.log(`💰 Profit: ${report.totalProfit > 0 ? '+' : ''}${report.totalProfit.toFixed(4)} SOL`);
            console.log(`🏆 Win Rate: ${report.winRate.toFixed(1)}%`);
            console.log(`🪙 Tokens: ${report.tokens.join(', ')}`);
            
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

    async exportAnalyticsToCSV() {
        try {
            const analytics = await this.loadAnalytics();
            let csvContent = 'Type,Category,Value,Trades,Profit,WinRate\n';
            
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

    async getOptimizationInsights() {
        console.log('\n🧠 INSIGHTS STRATÉGIQUES');
        console.log('═'.repeat(50));
        console.log('💡 Pas encore assez de données pour des insights détaillés');
        return { recommendations: ['Collecter plus de données de trading'] };
    }
}

module.exports = TradeLogger;