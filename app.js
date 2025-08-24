const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

class ApparelSheetsManager {
  constructor(spreadsheetId, apiKey) {
    this.spreadsheetId = spreadsheetId;
    this.apiKey = apiKey;
    this.baseUrl = "https://sheets.googleapis.com/v4/spreadsheets";
  }

  // Helper function to convert column letters to numbers
  columnToNumber(column) {
    let result = 0;
    for (let i = 0; i < column.length; i++) {
      result = result * 26 + (column.charCodeAt(i) - "A".charCodeAt(0) + 1);
    }
    return result;
  }

  // Helper function to convert numbers to column letters
  numberToColumn(number) {
    let result = "";
    while (number > 0) {
      number--;
      result = String.fromCharCode("A".charCodeAt(0) + (number % 26)) + result;
      number = Math.floor(number / 26);
    }
    return result;
  }

  async getFabricCosts() {
    try {
      const range = "Fabric!A:D"; // Adjust range as needed
      const response = await axios.get(
        `${this.baseUrl}/${this.spreadsheetId}/values/${range}`,
        {
          params: { key: this.apiKey },
        }
      );

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        return {};
      }

      const headers = rows[0];
      const dataRows = rows.slice(1);
      const fabricCosts = {};

      dataRows.forEach((row) => {
        const fabricType = row[0]; // Assuming first column is Fabric Type
        if (fabricType) {
          fabricCosts[fabricType] = {
            costPerMeter: parseFloat(row[1]) || 0,
            supplier: row[2] || "",
            description: row[3] || "",
          };
        }
      });

      return fabricCosts;
    } catch (error) {
      throw new Error(
        `Error getting fabric costs: ${
          error.response?.data?.error?.message || error.message
        }`
      );
    }
  }

  async getFabricCost(fabricType) {
    try {
      const fabricCosts = await this.getFabricCosts();
      const fabricData = fabricCosts[fabricType];

      if (fabricData) {
        return {
          fabricType: fabricType,
          ...fabricData,
        };
      }
      return null;
    } catch (error) {
      throw new Error(`Error getting fabric cost: ${error.message}`);
    }
  }

  async getFabricUsage() {
    try {
      const range = "Usage!A:B"; // Adjust range as needed
      const response = await axios.get(
        `${this.baseUrl}/${this.spreadsheetId}/values/${range}`,
        {
          params: { key: this.apiKey },
        }
      );

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        return {};
      }

      const dataRows = rows.slice(1);
      const dressMetreUsage = {};

      dataRows.forEach((row) => {
        const dressType = row[0]; // Assuming first column is Dress Type
        if (dressType) {
          dressMetreUsage[dressType] = {
            metres: parseFloat(row[1]) || 0,
          };
        }
      });

      return dressMetreUsage;
    } catch (error) {
      throw new Error(
        `Error getting fabric costs: ${
          error.response?.data?.error?.message || error.message
        }`
      );
    }
  }
}

// Initialize the sheets manager
const sheetsManager = new ApparelSheetsManager(
  process.env.SPREADSHEET_ID,
  process.env.GOOGLE_SHEETS_API_KEY
);

// API Routes

// Health check
app.get("/health", async (req, res) => {
  try {
    const sheetInfo = await sheetsManager.getSheetInfo();
    res.json({
      status: "OK",
      timestamp: new Date().toISOString(),
      spreadsheet: sheetInfo.title,
      sheets: sheetInfo.sheets,
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      error: "Could not connect to Google Sheets",
      message: error.message,
    });
  }
});

// Get all fabric costs
app.get("/api/fabric-costs", async (req, res) => {
  try {
    const fabricCosts = await sheetsManager.getFabricCosts();
    res.json({
      success: true,
      data: fabricCosts,
      count: Object.keys(fabricCosts).length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get specific fabric cost
app.get("/api/fabric-costs/:fabricType", async (req, res) => {
  try {
    const fabricType = decodeURIComponent(req.params.fabricType);
    const fabricCost = await sheetsManager.getFabricCost(fabricType);

    if (!fabricCost) {
      return res.status(404).json({
        success: false,
        error: `Fabric type "${fabricType}" not found`,
      });
    }

    res.json({
      success: true,
      data: fabricCost,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get fabric usage data
app.get("/api/fabric-usage", async (req, res) => {
  try {
    const { dressType, fabricType } = req.query;
    const usageData = await sheetsManager.getFabricUsage(dressType, fabricType);

    res.json({
      success: true,
      data: usageData,
      count: usageData.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: "Something went wrong!",
  });
});

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Apparel Sheets API server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📋 API Documentation:`);
  console.log(`   GET  /api/fabric-costs - Get all fabric costs`);
  console.log(
    `   GET  /api/fabric-costs/:fabricType - Get specific fabric cost`
  );
  console.log(
    `   GET  /api/fabric-usage - Get fabric usage data (with optional filters)`
  );
});

module.exports = app;
