const express = require('express');
const auth = require('../middleware/auth');
const Simulation = require('../models/Simulation');
const SimulationScenario = require('../models/SimulationScenario');

const router = express.Router();

router.get('/summary', auth, async (req, res) => {
  try {
    const userId = req.user.userId;

    // 1. Get Stats
    const totalSimulations = await Simulation.countDocuments({ user_id: userId, status: 'completed' });
    // Assume reports are simulations with deep analysis or just count all as placeholder for now
    const totalReports = totalSimulations; 
    
    // Average ROI calculation for impact
    const simulations = await Simulation.find({ user_id: userId, status: 'completed' }).limit(50);
    let totalRoi = 0;
    let scenarioCount = 0;
    
    for (const sim of simulations) {
        const scenarios = await SimulationScenario.find({ simulation_id: sim._id });
        scenarios.forEach(s => {
            totalRoi += (s.roi || 0);
            scenarioCount++;
        });
    }
    
    const impact = scenarioCount > 0 ? Math.round(totalRoi / scenarioCount) : 0;

    // 2. Get the most recent simulation group and its scenarios
    const latestSim = await Simulation.findOne({ user_id: userId, status: 'completed' })
      .sort({ created_at: -1 });

    let recentSimulationsData = [];
    if (latestSim) {
      const scenarios = await SimulationScenario.find({ simulation_id: latestSim._id });
      
      const dateStr = latestSim.created_at.toLocaleDateString('vi-VN', { 
        day: '2-digit', 
        month: 'short', 
        year: 'numeric' 
      }).toUpperCase();

      recentSimulationsData = [{
        id: latestSim._id.toString(),
        title: latestSim.folder_name || latestSim.title,
        date: dateStr,
        reliability: 95,
        scenarios: scenarios.map(s => ({
          id: s._id.toString(),
          title: s.title,
          description: s.description,
          type: s.scenario_type,
          metrics: {
            career: s.career_growth,
            happiness: s.happiness,
            roi: s.roi
          }
        }))
      }];
    }

    res.json({
      stats: {
        simulations: totalSimulations,
        reports: totalReports,
        impact: impact
      },
      recentSimulations: recentSimulationsData
    });

  } catch (error) {
    console.error('Dashboard summary error:', error);
    res.status(500).json({ message: 'Lỗi hệ thống khi tải dữ liệu dashboard.' });
  }
});

module.exports = router;
