const mongoose = require('mongoose');

const simulationScenarioSchema = new mongoose.Schema({
  simulation_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Simulation', required: true },
  scenario_type: { type: String, enum: ['Positive', 'Neutral', 'Risk'], required: true },
  title: { type: String, required: true },
  description: { type: String },
  career_growth: { type: Number },
  happiness: { type: Number },
  roi: { type: Number },
  probability: { type: Number, min: 0, max: 100 },
  timeline: [{ year: Number, milestone: String }],
  expected_salary: {
    year_3: { min: Number, avg: Number, max: Number },
    year_5: { min: Number, avg: Number, max: Number },
    year_10: { min: Number, avg: Number, max: Number }
  },
  risks: [String],
  deep_analysis: {
    swot: [{
      label: String,
      value: String,
      color: String,
      type: { type: String, enum: ['S', 'W', 'O', 'T'] }
    }],
    resources: [{
      label: String,
      value: Number,
      unit: String,
      icon: String,
      ghostLabel: String
    }],
    sprint90: [{
      phase: String,
      tasks: [String]
    }],
    criticalAdvice: String,
    riskMitigation: String
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false },
  collection: 'simulation_scenarios'
});

simulationScenarioSchema.index({ simulation_id: 1, scenario_type: 1 });

module.exports = mongoose.model('SimulationScenario', simulationScenarioSchema);
