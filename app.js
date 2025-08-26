/**
 * Apparel Sheets Management API
 *
 * A Node.js Express API for managing apparel designs with Google Sheets integration
 * and AWS S3 image storage. Provides endpoints for design management, fabric cost
 * tracking, and usage analytics.
 *
 * @version 1.1.0
 * @author Your Team
 * @license MIT
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { google } = require("googleapis");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const fs = require("fs");
const path = require("path");
const { addToDB, getFromDB, updateInDB } = require("./database");

require("dotenv").config();

// =============================================================================
// CONFIGURATION & CONSTANTS
// =============================================================================

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG = {
  FILE_SIZE_LIMIT: 10 * 1024 * 1024, // 10MB
  ALLOWED_IMAGE_TYPES: [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/tiff",
    "image/svg+xml",
  ],
  DEFAULT_SIGNED_URL_EXPIRY: 3600, // 1 hour
  UPLOADS_DIR: "uploads/",
  S3_FOLDER_PREFIX: "worldvastradesigns",
};

const DESIGN_SHEET_HEADERS = [
  "Design_Id",
  "Date_Added",
  "Client",
  "Fabric",
  "Comments",
  "referenceImageUrl",
  "referenceImages3Key",
  "fabricLength",
  "liningFabric",
  "liningLength",
  "Embroidery",
  "FinalDress",
  "Approved",
];

class Logger {
  /**
   * Log informational messages
   * @param {string} message - Log message
   * @param {Object} data - Additional data to log
   */
  static info(message, data = {}) {
    const logEntry = {
      level: "INFO",
      timestamp: new Date().toISOString(),
      message,
      ...data,
    };
    //console.log(JSON.stringify(logEntry, null, 2));
  }

  /**
   * Log error messages with stack traces
   * @param {string} message - Error message
   * @param {Error} error - Error object
   * @param {Object} data - Additional context data
   */
  static error(message, error = null, data = {}) {
    const logEntry = {
      level: "ERROR",
      timestamp: new Date().toISOString(),
      message,
      error: error
        ? {
            message: error.message,
            stack: error.stack,
            name: error.name,
          }
        : null,
      ...data,
    };
    console.error(JSON.stringify(logEntry, null, 2));
  }
}

// =============================================================================
// VALIDATION UTILITIES
// =============================================================================

/**
 * Validation utility class for request data
 */
class Validator {
  /**
   * Validate required fields in request body
   * @param {Object} data - Data to validate
   * @param {Array} requiredFields - Array of required field names
   * @throws {Error} If validation fails
   */
  static validateRequiredFields(data, requiredFields) {
    const missingFields = requiredFields.filter(
      (field) =>
        !data[field] ||
        (typeof data[field] === "string" && data[field].trim() === "")
    );

    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(", ")}`);
    }
  }

  /**
   * Validate file upload
   * @param {Object} file - Multer file object
   * @throws {Error} If file validation fails
   */
  static validateFile(file) {
    if (!file) {
      throw new Error("No file uploaded");
    }

    if (!file.mimetype.startsWith("image/")) {
      throw new Error("Only image files are allowed");
    }

    if (file.size > CONFIG.FILE_SIZE_LIMIT) {
      throw new Error(
        `File too large. Maximum size is ${
          CONFIG.FILE_SIZE_LIMIT / (1024 * 1024)
        }MB`
      );
    }
  }

  /**
   * Sanitize string for use in filenames
   * @param {string} str - String to sanitize
   * @returns {string} Sanitized string
   */
  static sanitizeFilename(str) {
    return str.replace(/[^a-zA-Z0-9]/g, "_");
  }
}

// =============================================================================
// MIDDLEWARE CONFIGURATION
// =============================================================================

// Configure multer for file uploads
const upload = multer({
  dest: "uploads/",
  fileFilter: (req, file, cb) => {
    // Only allow image files
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

// Middleware
app.use(express.json());
app.use(cors());

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - startTime;
    Logger.info("Request completed", {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get("User-Agent"),
    });
  });

  next();
});

/**
 * ApparelSheetsManager
 *
 * Main class for managing apparel design data with Google Sheets and AWS S3 integration.
 * Uses Google Service Account for all sheet operations (both read and write).
 */
class ApparelSheetsManager {
  /**
   * Initialize the ApparelSheetsManager
   *
   * @param {string} spreadsheetId - Google Sheets spreadsheet ID
   * @param {string|Object} serviceAccountCredentials - Service account credentials
   */
  constructor(spreadsheetId, serviceAccountCredentials) {
    this.spreadsheetId = spreadsheetId;
    this.serviceAccountCredentials = serviceAccountCredentials;
    this.auth = null;
    this.sheets = null;

    // Initialize S3 client
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    this.bucketName = process.env.AWS_S3_BUCKET_NAME;
    this.s3BaseUrl = `https://${this.bucketName}.s3.${
      process.env.AWS_REGION || "us-east-1"
    }.amazonaws.com`;
  }

  /**
   * Initialize Google Sheets authentication using service account
   * Required for both read and write operations to Google Sheets
   *
   * @throws {Error} If service account credentials are invalid or missing
   */
  async initializeAuth() {
    if (this.auth && this.sheets) {
      return;
    }

    if (!this.serviceAccountCredentials) {
      const error = new Error(
        "Service account credentials are required for Sheets operations"
      );
      Logger.error("Missing service account credentials", error);
      throw error;
    }

    try {
      const credentials =
        typeof this.serviceAccountCredentials === "string"
          ? JSON.parse(this.serviceAccountCredentials)
          : this.serviceAccountCredentials;

      const googleAuth = new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });

      const authClient = await googleAuth.getClient();
      this.auth = authClient;
      this.sheets = google.sheets({ version: "v4", auth: this.auth });
    } catch (error) {
      Logger.error("Failed to initialize Google Sheets API", error);
      throw new Error(
        `Failed to initialize Google Sheets API: ${error.message}`
      );
    }
  }

  /**
   * Upload image to AWS S3 with comprehensive metadata and error handling
   *
   * @param {string} filePath - Local file path of the image to upload
   * @param {string} fileName - Original filename
   * @param {string} clientName - Client name for organization
   * @returns {Promise<Object>} S3 upload result with URL and metadata
   * @throws {Error} If upload fails or S3 configuration is invalid
   */
  async uploadImageToS3(filePath, fileName, clientName) {
    if (!this.bucketName) {
      throw new Error("AWS_S3_BUCKET_NAME is required");
    }

    const fileExtension = path.extname(fileName);
    const timestamp = Date.now();
    const s3Key = `worldvastradesigns/${clientName.replace(
      /[^a-zA-Z0-9]/g,
      "_"
    )}_${timestamp}${fileExtension}`;

    try {
      // Read file
      const fileContent = fs.readFileSync(filePath);

      // Determine content type
      const contentType = this.getContentType(fileExtension);

      // Upload to S3
      const uploadCommand = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
        Body: fileContent,
        ContentType: contentType,
        Metadata: {
          "client-name": clientName,
          "original-filename": fileName,
          "upload-timestamp": timestamp.toString(),
        },
      });

      const result = await this.s3Client.send(uploadCommand);

      // Clean up local file
      fs.unlinkSync(filePath);

      return {
        key: s3Key,
        url: `${this.s3BaseUrl}/${s3Key}`,
        etag: result.ETag,
        bucket: this.bucketName,
        contentType: contentType,
      };
    } catch (error) {
      Logger.error("S3 upload failed", error, {
        filePath,
        fileName,
        clientName,
      });
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      throw new Error(`Failed to upload image to S3: ${error.message}`);
    }
  }

  /**
   * Generate signed URL for temporary access to S3 object
   * @param {string} s3Key - S3 object key
   * @param {number} expiresIn - URL expiration time in seconds
   * @returns {Promise<string>} Signed URL
   */
  async generateSignedUrl(s3Key, expiresIn = 3600) {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn,
      });
      return signedUrl;
    } catch (error) {
      Logger.error("Failed to generate signed URL", error, { s3Key });
      throw new Error(`Failed to generate signed URL: ${error.message}`);
    }
  }

  /**
   * Delete image from S3
   * @param {string} s3Key - S3 object key to delete
   * @returns {Promise<Object>} Deletion result
   */
  async deleteImageFromS3(s3Key) {
    try {
      const deleteCommand = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      });

      await this.s3Client.send(deleteCommand);
      return { success: true, message: `Deleted ${s3Key} from S3` };
    } catch (error) {
      Logger.error("Failed to delete image from S3", error, { s3Key });
      throw new Error(`Failed to delete image from S3: ${error.message}`);
    }
  }

  /**
   * Get content type based on file extension
   * @param {string} extension - File extension
   * @returns {string} MIME type
   */
  getContentType(extension) {
    const mimeTypes = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".tiff": "image/tiff",
      ".svg": "image/svg+xml",
    };
    return mimeTypes[extension.toLowerCase()] || "application/octet-stream";
  }

  /**
   * Add new design to Google Sheets
   * @param {Object} designData - Design data to add
   * @returns {Promise<Object>} Sheet update result
   */
  async addDesign(designData) {
    await this.initializeAuth();

    try {
      const range = "Designs!A:N";
      const values = [
        [
          designData.designId, // Design ID - generate this dynamically
          new Date().toISOString().split("T")[0], // Date
          designData.clientName,
          designData.dressType,
          designData.fabric,
          designData.designerComments,
          designData.imageUrl,
          designData.s3Key || "",
          "",
          "",
          "",
          "",
          "",
          false,
        ],
      ];

      const response = await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range: range,
        valueInputOption: "RAW",
        resource: {
          values: values,
        },
      });

      return {
        updatedRows: response.data.updates.updatedRows,
        updatedRange: response.data.updates.updatedRange,
      };
    } catch (error) {
      Logger.error("Failed to add design to sheet", error, designData);
      throw new Error(`Failed to add design to sheet: ${error.message}`);
    }
  }

  /**
   * Get all designs from Google Sheets using Service Account
   * @param {number} limit - Maximum number of designs to return
   * @param {boolean} includeSignedUrls - Whether to generate signed URLs
   * @returns {Promise<Array>} Array of design objects
   */
  async getDesigns(limit = null, includeSignedUrls = false) {
    await this.initializeAuth();

    try {
      const range = "Designs!A:G";
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: range,
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        return [];
      }

      const headers = [
        "date",
        "clientName",
        "fabric",
        "imageUrl",
        "s3Key",
        "designerComments",
        "status",
      ];
      const dataRows = rows.slice(1); // Skip header row

      let designs = dataRows.map((row, index) => {
        const design = { id: index + 1 };
        headers.forEach((header, i) => {
          design[header] = row[i] || "";
        });
        return design;
      });

      // Generate signed URLs if requested
      if (includeSignedUrls) {
        for (let design of designs) {
          if (design.s3Key) {
            try {
              design.signedUrl = await this.generateSignedUrl(design.s3Key);
            } catch (error) {
              Logger.error("Failed to generate signed URL", error, {
                designId: design.id,
                s3Key: design.s3Key,
              });
              design.signedUrl = null;
            }
          }
        }
      }

      // Apply limit if specified
      if (limit && limit > 0) {
        designs = designs.slice(0, limit);
      }

      return designs;
    } catch (error) {
      Logger.error("Error getting designs from sheet", error);
      throw new Error(`Error getting designs: ${error.message}`);
    }
  }

  /**
   * Get all fabric costs from Google Sheets using Service Account
   * @returns {Promise<Object>} Fabric costs data
   */
  async getFabricCosts() {
    await this.initializeAuth();

    try {
      const range = "Fabric!A:D";
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: range,
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        return {};
      }

      const headers = rows[0];
      const dataRows = rows.slice(1);
      const fabricCosts = {};

      dataRows.forEach((row) => {
        const fabricType = row[0];
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
      Logger.error("Error getting fabric costs from sheet", error);
      throw new Error(`Error getting fabric costs: ${error.message}`);
    }
  }

  /**
   * Get fabric usage data from Google Sheets using Service Account
   * @returns {Promise<Object>} Fabric usage data
   */
  async getFabricUsage() {
    await this.initializeAuth();

    try {
      const range = "Usage!A:B";
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: range,
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        return {};
      }

      const dataRows = rows.slice(1); // Skip header row
      const dressMetreUsage = {};

      dataRows.forEach((row) => {
        const dressType = row[0];
        if (dressType) {
          dressMetreUsage[dressType] = {
            metres: parseFloat(row[1]) || 0,
          };
        }
      });

      return dressMetreUsage;
    } catch (error) {
      Logger.error("Error getting fabric usage from sheet", error);
      throw new Error(`Error getting fabric usage: ${error.message}`);
    }
  }

  /**
   * Test connection to Google Sheets
   * @returns {Promise<Object>} Connection test result
   */
  async testConnection() {
    try {
      await this.initializeAuth();

      // Try to get spreadsheet metadata
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
      });

      return {
        connected: true,
        spreadsheetTitle: response.data.properties.title,
        sheetCount: response.data.sheets.length,
        lastModified: response.data.properties.timeZone,
      };
    } catch (error) {
      Logger.error("Google Sheets connection test failed", error);
      return {
        connected: false,
        error: error.message,
      };
    }
  }
}

// Initialize the sheets manager
const sheetsManager = new ApparelSheetsManager(
  process.env.SPREADSHEET_ID,
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY
);

// =============================================================================
// API ROUTES
// =============================================================================

/**
 * Health check endpoint
 * Tests connections to Google Sheets and provides system status
 */
app.get("/health", async (req, res) => {
  try {
    // Test Google Sheets connection
    const sheetsStatus = await sheetsManager.testConnection();

    // Test fabric costs access
    let fabricTypesCount = 0;
    try {
      const fabricCosts = await sheetsManager.getFabricCosts();
      fabricTypesCount = Object.keys(fabricCosts).length;
    } catch (error) {
      Logger.error("Health check: Failed to get fabric costs", error);
    }

    res.json({
      status: "OK",
      timestamp: new Date().toISOString(),
      services: {
        googleSheets: sheetsStatus,
        s3: {
          configured: !!(
            process.env.AWS_S3_BUCKET_NAME &&
            process.env.AWS_ACCESS_KEY_ID &&
            process.env.AWS_SECRET_ACCESS_KEY
          ),
          bucket: process.env.AWS_S3_BUCKET_NAME,
          region: process.env.AWS_REGION || "us-east-1",
        },
      },
      fabricTypesCount,
    });
  } catch (error) {
    Logger.error("Health check failed", error);
    res.status(500).json({
      status: "Error",
      error: "Could not connect to services",
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Add new design with image upload to S3
 */
app.post("/api/designs", upload.single("designImage"), async (req, res) => {
  try {
    const { designId, clientCode, fabric, designerComments, dressType } =
      req.body;

    // Validate required fields
    Validator.validateRequiredFields(req.body, [
      "designId",
      "clientCode",
      "fabric",
    ]);

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Design image is required",
      });
    }

    // Validate uploaded file
    Validator.validateFile(req.file);

    // Upload image to S3
    const s3Data = await sheetsManager.uploadImageToS3(
      req.file.path,
      req.file.originalname,
      clientCode
    );

    // Add design data to Google Sheets
    const designData = {
      designId,
      clientCode,
      fabric,
      imageUrl: s3Data.url,
      s3Key: s3Data.key,
      dressType: dressType,
      designerComments: designerComments || "",
    };

    const sheetResult = await sheetsManager.addDesign(designData);
    const newDesign = await addToDB("sampling_designs", {
      design_id: designData.designId,
      date_added: new Date().toISOString().split("T")[0],
      dress_type: designData.dressType,
      client: designData.clientCode,
      fabric: designData.fabric,
      comments: designData.designerComments,
      reference_image: designData.imageUrl,
      rowid: sheetResult.updatedRange,
      approved: "False",
    });
    res.json({
      success: true,
      message: "Design added successfully",
      data: {
        ...designData,
        s3Info: {
          bucket: s3Data.bucket,
          key: s3Data.key,
          etag: s3Data.etag,
          contentType: s3Data.contentType,
        },
        sheetUpdates: sheetResult,
      },
    });
  } catch (error) {
    Logger.error("Failed to add design", error, { body: req.body });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Update a design with optional image upload to S3
 */
app.put("/api/designs", upload.single("finalImage"), async (req, res) => {
  try {
    const { range, updatedData } = req.body;
    Validator.validateRequiredFields(req.body, ["range", "updatedData"]);
    const parsedBody = JSON.parse(updatedData);
    if (req.file) {
      const s3Data = await sheetsManager.uploadImageToS3(
        req.file.path,
        req.file.originalname,
        parsedBody.client
      );
      parsedBody.finalDressUrl = s3Data.url;
    }

    // Define the correct order of columns to match the Google Sheet
    const orderedColumns = [
      "designId",
      "dateAdded",
      "client",
      "dressType",
      "fabric",
      "comments",
      "referenceImageUrl",
      "referenceImages3Key",
      "fabricLength",
      "liningfabric",
      "liningLength",
      "embroidery",
      "finalDressUrl",
      "approved",
    ];

    // Convert object to array based on column order
    const rowData = orderedColumns.map((col) => parsedBody[col] || "");
    await sheetsManager.initializeAuth();

    const response = await sheetsManager.sheets.spreadsheets.values.update({
      spreadsheetId: sheetsManager.spreadsheetId,
      range: range, // e.g., "Designs!A25:H25"
      valueInputOption: "RAW",
      resource: {
        values: [rowData],
      },
    });
    const updatedDesign = await updateInDB(
      "sampling_designs",
      {
        date_added: parsedBody.dateAdded,
        client: parsedBody.client,
        fabric: parsedBody.fabric,
        comments: parsedBody.comments,
        reference_image: parsedBody.referenceImageUrl,
        s3_key: parsedBody.referenceImages3Key,
        dress_type: parsedBody.dress_type,
        approved: parsedBody.approved,
        final_dress: parsedBody.final_dress,
      },
      { design_id: parsedBody.designId }
    );

    res.json({
      success: true,
      message: `Sheet updated at range ${range}`,
      updatedCells: response.data.updatedCells,
      updatedRange: response.data.updatedRange,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get all designs with optional filters
 */
app.get("/api/designs/:designId", async (req, res) => {
  try {
    const designId = req.params.designId;
    const designs = await getFromDB(
      "sampling_designs",
      {
        design_id: designId,
      },
      {
        limit: 1,
      }
    );
    res.json({
      success: true,
      message: "Design fetched successfully",
      data: designs,
    });
  } catch (error) {
    Logger.error("Failed to get designs", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get all fabric costs
 */
app.get("/api/fabric-costs", async (req, res) => {
  try {
    const fabricCosts = await sheetsManager.getFabricCosts();

    res.json({
      success: true,
      data: fabricCosts,
      count: Object.keys(fabricCosts).length,
    });
  } catch (error) {
    Logger.error("Failed to get fabric costs", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get fabric usage data
 */
app.get("/api/fabric-usage", async (req, res) => {
  try {
    const usageData = await sheetsManager.getFabricUsage();

    res.json({
      success: true,
      data: usageData,
      count: Object.keys(usageData).length,
    });
  } catch (error) {
    Logger.error("Failed to get fabric usage", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// =============================================================================
// ERROR HANDLING MIDDLEWARE
// =============================================================================

/**
 * Multer error handling
 */
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        error: "File too large. Maximum size is 10MB.",
      });
    }
    return res.status(400).json({
      success: false,
      error: `Upload error: ${err.message}`,
    });
  }

  if (err.message === "Only image files are allowed") {
    return res.status(400).json({
      success: false,
      error: "Only image files are allowed",
    });
  }

  Logger.error("Unhandled error", err);
  res.status(500).json({
    success: false,
    error: "Something went wrong!",
  });
});

/**
 * 404 handler for undefined routes
 */
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
    availableRoutes: [
      "GET /health",
      "POST /api/designs",
      "PUT /api/designs",
      "GET /api/designs/:designId",
      "GET /api/fabric-costs",
      "GET /api/fabric-usage",
    ],
  });
});

// =============================================================================
// SERVER STARTUP
// =============================================================================

app.listen(PORT, () => {
  console.log(`🚀 World Vastra API server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📋 API Documentation:`);
  console.log(`   POST /api/designs - Add new design (with S3 image upload)`);
  console.log(`   PUT /api/designs - Update design (with S3 image upload)`);
  console.log(`   GET  /api/designs/:designId - Get design by design Id`);
  console.log(`   GET  /api/fabric-costs - Get all fabric costs`);
  console.log(`   GET  /api/fabric-usage - Get fabric usage data`);
});

module.exports = app;
