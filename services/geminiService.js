const { GoogleGenAI, Type } = require('@google/genai');

const getAI = () => {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
};

const generateSimulation = async (data) => {
  const ai = getAI();

  const prompt = `
    Bạn là chuyên gia phân tích tương lai của hệ thống FutureTrace.
    
    NHIỆM VỤ: Phân tích quyết định và giả lập các kịch bản tương lai.
    
    QUY TẮC PHÂN LOẠI ĐỐI TƯỢNG (BẮT BUỘC):
    1. Đối tượng hỗ trợ: Chỉ dành cho học sinh cấp 3 (lớp 10-12) và sinh viên đại học/cao đẳng tại Việt Nam (độ tuổi từ 16 đến 22). Nội dung phải xoay quanh việc học tập, chọn ngành, chọn trường, áp lực thi cử, hoặc các vấn đề đời sống học đường.
    2. Đối tượng doanh nghiệp/người lao động: Nếu người dùng là người đã đi làm, người lao động, hoặc nội dung câu hỏi đi sâu vào các lĩnh vực nghề nghiệp chuyên nghiệp (ví dụ: thăng tiến, quản trị doanh nghiệp, kinh doanh chuyên sâu, tìm việc làm cho người đã có kinh nghiệm):
       - Bạn PHẢI đặt trường "isEnterprise" là true.
       - Phần 'summary' phải ghi chính xác là: "Hệ thống nhận diện bạn đang yêu cầu phân tích chuyên sâu về lĩnh vực nghề nghiệp hoặc các vấn đề dành cho người lao động. Phiên bản này hiện chỉ tối ưu cho học sinh và sinh viên (16-22 tuổi). Vui lòng Nâng cấp lên bản dành cho doanh nghiệp để nhận được các phân tích chuyên sâu về thị trường lao động, lộ trình thăng tiến và chiến lược kinh doanh."
       - Các trường 'scenarios' và 'timeline' để trống hoặc giá trị mặc định tối thiểu.

    Dữ liệu đầu vào (BẠN PHẢI DỰA VÀO ĐÂY ĐỂ PHÂN TÍCH):
    - Quyết định/Vấn đề: ${data.decision}
    - Mức độ áp lực hiện tại: ${data.stress}/5
    - Tài chính cá nhân: ${data.personalFinance}/5
    - Học lực/Năng lực: ${data.academicPerformance}/5
    - Chỉ số rủi ro: ${data.risk}/5
    - Các yếu tố khác: ${data.otherFactors || 'Không có'}

    YÊU CẦU PHÂN TÍCH CHI TIẾT:
    - Các chỉ số Career Growth, Happiness, ROI trong từng kịch bản phải phản ánh logic từ dữ liệu đầu vào.
    - Phần "deepAnalysis" -> "resources" (Thời gian, Tài chính, Năng lượng): Tổng 3 giá trị = 100.
    - Phần "criticalAdvice": Lời khuyên thực tế dựa trên sự kết hợp giữa "Quyết định" và "Yếu tố khác".
    - Timeline: Các cột mốc phải thực tế với trình độ học vấn và bối cảnh của học sinh/sinh viên Việt Nam.

    YÊU CẦU ĐẦU RA (JSON):
    Nếu isEnterprise là false:
    Tạo 3 kịch bản: Tích cực (Positive), Trung lập (Neutral), và Rủi ro (Risk).
    Mỗi kịch bản PHẢI có phần "deepAnalysis" bằng tiếng Việt gồm:
    1. Phân tích SWOT (ít nhất 4 mục).
    2. Nhu cầu nguồn lực: Thời gian, Tài chính, Năng lượng tinh thần (Tổng 3 giá trị = 100).
    3. Chiến thuật cơ bản (3 giai đoạn).
    4. Một lời khuyên chiến lược quan trọng.
    
    Ngôn ngữ: Tiếng Việt.
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          isEnterprise: { type: Type.BOOLEAN },
          summary: { type: Type.STRING },
          scenarios: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                description: { type: Type.STRING },
                careerGrowth: { type: Type.NUMBER },
                happiness: { type: Type.NUMBER },
                roi: { type: Type.NUMBER },
                type: { type: Type.STRING },
                deepAnalysis: {
                  type: Type.OBJECT,
                  properties: {
                    swot: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          label: { type: Type.STRING },
                          value: { type: Type.STRING },
                          color: { type: Type.STRING },
                          type: { type: Type.STRING }
                        }
                      }
                    },
                    resources: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          label: { type: Type.STRING },
                          value: { type: Type.NUMBER },
                          unit: { type: Type.STRING },
                          icon: { type: Type.STRING },
                          ghostLabel: { type: Type.STRING }
                        }
                      }
                    },
                    sprint90: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          phase: { type: Type.STRING },
                          tasks: { type: Type.ARRAY, items: { type: Type.STRING } }
                        }
                      }
                    },
                    criticalAdvice: { type: Type.STRING }
                  }
                }
              },
              required: ['title', 'description', 'careerGrowth', 'happiness', 'roi', 'type', 'deepAnalysis']
            }
          },
          timeline: {
            type: Type.OBJECT,
            properties: {
              start: { type: Type.STRING },
              sixMonths: { type: Type.STRING },
              oneYear: { type: Type.STRING },
              threeYears: { type: Type.STRING }
            }
          }
        },
        required: ['isEnterprise', 'summary', 'scenarios', 'timeline']
      }
    }
  });

  if (!response || !response.text) {
    throw new Error('AI không trả về kết quả.');
  }

  return JSON.parse(response.text.trim());
};

const generatePremiumAnalysis = async (title, description, context, timeframe) => {
  const ai = getAI();

  const prompt = `
    Generate a PREMIUM DETAILED SCENARIO REPORT for the following scenario:
    Title: ${title}
    Context: ${description}
    ${context ? `
    User Context:
    - Current Situation: ${context.decision}
    - Stress Level: ${context.stress}/5
    - Financial Status: ${context.personalFinance}/5
    - Academic Performance: ${context.academicPerformance}/5
    - Risk Tolerance: ${context.risk}/5
    - Other Factors: ${context.otherFactors || 'None'}
    ` : ''}
    ${timeframe ? `Target Completion Timeframe: ${timeframe} months.` : ''}

    CRITICAL INSTRUCTION FOR MILESTONES:
    - The milestones MUST be realistic based on the user's current situation.
    - ${timeframe ? `The ENTIRE roadmap must fit within ${timeframe} months.` : 'The timeline should be logical and progressive.'}
    - The report must include:
      1. detailedNarrative: A long, detailed description of how the next ${timeframe || 12} months will unfold (Vietnamese).
      2. milestones: 5 key events with month, description, impact level, probability (0-100), and a "details" field with step-by-step instructions (Vietnamese).
      3. influencingFactors: 4 external or internal factors with their influence level (High, Medium, Low).
      4. strategicPivotPoints: 3 critical "If/Then" decision points.
      5. longTermProjection: A final outlook on the 3-5 year horizon.

    Language: Vietnamese. Use a professional, analytical tone.
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          detailedNarrative: { type: Type.STRING },
          milestones: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                month: { type: Type.STRING },
                event: { type: Type.STRING },
                impact: { type: Type.STRING },
                probability: { type: Type.NUMBER },
                details: { type: Type.STRING }
              }
            }
          },
          influencingFactors: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                category: { type: Type.STRING },
                factor: { type: Type.STRING },
                influence: { type: Type.STRING },
                description: { type: Type.STRING }
              }
            }
          },
          strategicPivotPoints: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                condition: { type: Type.STRING },
                action: { type: Type.STRING }
              }
            }
          },
          longTermProjection: { type: Type.STRING }
        },
        required: ['detailedNarrative', 'milestones', 'influencingFactors', 'strategicPivotPoints', 'longTermProjection']
      }
    }
  });

  return JSON.parse(response.text.trim());
};

const pivotPremiumAnalysis = async (currentReport, completedMilestones, feedback, context, timeframe) => {
  const ai = getAI();

  const prompt = `
    RE-PLANNING REQUIRED based on user feedback.
    
    ORIGINAL SCENARIO:
    - Narrative: ${currentReport.detailedNarrative}
    
    COMPLETED MILESTONES:
    ${completedMilestones.map(m => `- ${m.month}: ${m.event}`).join('\n')}
    
    USER FEEDBACK/DIFFICULTIES:
    "${feedback}"
    
    ${context ? `
    User Context:
    - Current Situation: ${context.decision}
    - Stress Level: ${context.stress}/5
    - Financial Status: ${context.personalFinance}/5
    - Academic Performance: ${context.academicPerformance}/5
    - Risk Tolerance: ${context.risk}/5
    - Other Factors: ${context.otherFactors || 'None'}
    ` : ''}
    ${timeframe ? `Target Completion Timeframe: ${timeframe} months.` : ''}

    TASK:
    - Keep the COMPLETED milestones as they are.
    - REGENERATE all remaining milestones to better fit the user's current difficulties and feedback.
    - Adjust the detailedNarrative, influencingFactors, strategicPivotPoints, and longTermProjection to reflect this new reality.
    - Ensure the total number of milestones remains 5 (including the completed ones).
    - The new milestones must be realistic and address the feedback provided.

    Return ONLY a valid JSON object matching the PremiumAnalysisReport interface.
    Language: Vietnamese.
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          detailedNarrative: { type: Type.STRING },
          milestones: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                month: { type: Type.STRING },
                event: { type: Type.STRING },
                impact: { type: Type.STRING },
                probability: { type: Type.NUMBER },
                details: { type: Type.STRING }
              }
            }
          },
          influencingFactors: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                category: { type: Type.STRING },
                factor: { type: Type.STRING },
                influence: { type: Type.STRING },
                description: { type: Type.STRING }
              }
            }
          },
          strategicPivotPoints: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                condition: { type: Type.STRING },
                action: { type: Type.STRING }
              }
            }
          },
          longTermProjection: { type: Type.STRING }
        },
        required: ['detailedNarrative', 'milestones', 'influencingFactors', 'strategicPivotPoints', 'longTermProjection']
      }
    }
  });

  return JSON.parse(response.text.trim());
};

module.exports = { generateSimulation, generatePremiumAnalysis, pivotPremiumAnalysis };
