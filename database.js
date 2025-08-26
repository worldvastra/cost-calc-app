/**
 * Database Operations Module
 *
 * Provides simple functions for PostgreSQL database operations
 * Usage: const { addToDB, getFromDB, updateInDB } = require('./database');
 */

const { Pool } = require("pg");
require("dotenv").config();

// =============================================================================
// DATABASE CONNECTION SETUP
// =============================================================================

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: {
    rejectUnauthorized: false,
    require: true,
  },
  // Add these for connection issues
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Handle database errors
 */
const handleError = (operation, error, context = {}) => {
  // Handle common PostgreSQL errors
  switch (error.code) {
    case "23505": // Unique constraint violation
      throw new Error("Record with this identifier already exists");
    case "23503": // Foreign key violation
      throw new Error("Referenced record does not exist");
    case "23502": // Not null violation
      throw new Error("Required field is missing");
    case "42P01": // Table does not exist
      throw new Error("Table does not exist");
    default:
      throw new Error(`Database operation failed: ${error.message}`);
  }
};

// =============================================================================
// MAIN DATABASE FUNCTIONS
// =============================================================================

/**
 * Add record to database
 * @param {string} table - Table name
 * @param {Object} data - Data to insert
 * @param {string} [returnFields='*'] - Fields to return after insert
 * @returns {Promise<Object>} Inserted record
 */
async function addToDB(table, data, returnFields = "*") {
  const client = await pool.connect();
  try {
    // Extract columns and values
    const columns = Object.keys(data);
    const values = Object.values(data);
    const placeholders = columns.map((_, index) => `$${index + 1}`);

    // Build INSERT query
    const query = `
      INSERT INTO ${table} (${columns.join(", ")})
      VALUES (${placeholders.join(", ")})
      RETURNING ${returnFields};
    `;

    const result = await client.query(query, values);

    if (result.rows.length === 0) {
      throw new Error("Insert operation failed - no record returned");
    }

    return result.rows[0];
  } catch (error) {
    handleError("addToDB", error, { table, data });
  } finally {
    client.release();
  }
}

/**
 * Get records from database
 * @param {string} table - Table name
 * @param {Object} [conditions={}] - WHERE conditions
 * @param {Object} [options={}] - Query options
 * @returns {Promise<Array>} Retrieved records
 */
async function getFromDB(table, conditions = {}, options = {}) {
  const client = await pool.connect();

  try {
    const {
      columns = "*",
      orderBy = null,
      limit = null,
      offset = null,
      operator = "AND", // AND or OR
    } = options;

    let query = `SELECT ${columns} FROM ${table}`;
    let values = [];
    let paramCount = 1;

    // Build WHERE clause
    if (Object.keys(conditions).length > 0) {
      const whereConditions = [];

      for (const [key, value] of Object.entries(conditions)) {
        if (value === null) {
          whereConditions.push(`${key} IS NULL`);
        } else if (Array.isArray(value)) {
          // Handle IN clause
          const placeholders = value.map(() => `$${paramCount++}`);
          whereConditions.push(`${key} IN (${placeholders.join(", ")})`);
          values.push(...value);
        } else if (typeof value === "object" && value.operator) {
          // Handle custom operators like { operator: 'LIKE', value: '%test%' }
          whereConditions.push(`${key} ${value.operator} $${paramCount++}`);
          values.push(value.value);
        } else {
          whereConditions.push(`${key} = $${paramCount++}`);
          values.push(value);
        }
      }

      query += ` WHERE ${whereConditions.join(` ${operator} `)}`;
    }

    // Add ORDER BY
    if (orderBy) {
      query += ` ORDER BY ${orderBy}`;
    }

    // Add LIMIT
    if (limit) {
      query += ` LIMIT $${paramCount++}`;
      values.push(limit);
    }

    // Add OFFSET
    if (offset) {
      query += ` OFFSET $${paramCount++}`;
      values.push(offset);
    }

    const result = await client.query(query, values);
    return result.rows;
  } catch (error) {
    handleError("getFromDB", error, { table, conditions, options });
  } finally {
    client.release();
  }
}

/**
 * Update records in database
 * @param {string} table - Table name
 * @param {Object} data - Data to update
 * @param {Object} conditions - WHERE conditions
 * @param {string} [returnFields='*'] - Fields to return after update
 * @returns {Promise<Array>} Updated records
 */
async function updateInDB(table, data, conditions, returnFields = "*") {
  const client = await pool.connect();

  try {
    if (Object.keys(conditions).length === 0) {
      throw new Error(
        "Update conditions are required to prevent updating all records"
      );
    }

    if (Object.keys(data).length === 0) {
      throw new Error("No data provided for update");
    }

    let paramCount = 1;
    let values = [];

    // Build SET clause
    const setClause = [];
    for (const [key, value] of Object.entries(data)) {
      setClause.push(`${key} = $${paramCount++}`);
      values.push(value);
    }

    // Build WHERE clause
    const whereConditions = [];
    for (const [key, value] of Object.entries(conditions)) {
      if (value === null) {
        whereConditions.push(`${key} IS NULL`);
      } else if (Array.isArray(value)) {
        const placeholders = value.map(() => `$${paramCount++}`);
        whereConditions.push(`${key} IN (${placeholders.join(", ")})`);
        values.push(...value);
      } else {
        whereConditions.push(`${key} = $${paramCount++}`);
        values.push(value);
      }
    }

    const query = `
      UPDATE ${table}
      SET ${setClause.join(", ")}
      WHERE ${whereConditions.join(" AND ")}
      RETURNING ${returnFields};
    `;

    const result = await client.query(query, values);

    if (result.rows.length === 0) {
      throw new Error("No records found matching the update conditions");
    }

    return result.rows;
  } catch (error) {
    handleError("updateInDB", error, { table, data, conditions });
  } finally {
    client.release();
  }
}

// =============================================================================
// ADDITIONAL HELPER FUNCTIONS
// =============================================================================

/**
 * Delete records from database
 * @param {string} table - Table name
 * @param {Object} conditions - WHERE conditions
 * @param {string} [returnFields='*'] - Fields to return after delete
 * @returns {Promise<Array>} Deleted records
 */
async function deleteFromDB(table, conditions, returnFields = "*") {
  const client = await pool.connect();

  try {
    if (Object.keys(conditions).length === 0) {
      throw new Error(
        "Delete conditions are required to prevent deleting all records"
      );
    }

    let paramCount = 1;
    let values = [];

    const whereConditions = [];
    for (const [key, value] of Object.entries(conditions)) {
      if (value === null) {
        whereConditions.push(`${key} IS NULL`);
      } else if (Array.isArray(value)) {
        const placeholders = value.map(() => `$${paramCount++}`);
        whereConditions.push(`${key} IN (${placeholders.join(", ")})`);
        values.push(...value);
      } else {
        whereConditions.push(`${key} = $${paramCount++}`);
        values.push(value);
      }
    }

    const query = `
      DELETE FROM ${table}
      WHERE ${whereConditions.join(" AND ")}
      RETURNING ${returnFields};
    `;

    const result = await client.query(query, values);
    return result.rows;
  } catch (error) {
    handleError("deleteFromDB", error, { table, conditions });
  } finally {
    client.release();
  }
}

/**
 * Test database connection
 * @returns {Promise<Object>} Connection status
 */
async function testConnection() {
  try {
    const client = await pool.connect();
    const result = await client.query(
      "SELECT NOW() as current_time, version() as version"
    );
    client.release();

    return {
      connected: true,
      currentTime: result.rows[0].current_time,
      version: result.rows[0].version,
      poolStats: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
      },
    };
  } catch (error) {
    return {
      connected: false,
      error: error.message,
    };
  }
}

/**
 * Close database connection pool
 */
async function closeConnection() {
  try {
    await pool.end();
    console.log("Database connection pool closed");
  } catch (error) {
    console.error("Error closing database connection pool:", error.message);
  }
}

// =============================================================================
// TRANSACTION HELPERS
// =============================================================================

/**
 * Execute multiple operations in a transaction
 * @param {Function} operations - Async function that receives a client
 * @returns {Promise} Transaction result
 */
async function executeTransaction(operations) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await operations(client);

    await client.query("COMMIT");

    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    handleError("executeTransaction", error);
  } finally {
    client.release();
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  // Main functions
  addToDB,
  getFromDB,
  updateInDB,
};

// =============================================================================
// USAGE EXAMPLES (commented out)
// =============================================================================

/*

// Example 1: Add a new design
const newDesign = await addToDB('designs', {
  design_id: 'D001',
  client: 'John Doe',
  fabric: 'Cotton',
  comments: 'Special design for wedding'
});

// Example 2: Get all designs for a specific client
const clientDesigns = await getFromDB('designs', 
  { client: 'John Doe' },
  { orderBy: 'created_at DESC', limit: 10 }
);

// Example 3: Get designs with LIKE search
const searchResults = await getFromDB('designs',
  { 
    client: { operator: 'LIKE', value: '%John%' },
    approved: 'Yes'
  },
  { orderBy: 'date_added DESC' }
);

// Example 4: Update design status
const updatedDesign = await updateInDB('designs',
  { approved: 'Yes', final_dress: 'Completed' },
  { design_id: 'D001' }
);

// Example 5: Get designs with multiple conditions
const designs = await getFromDB('designs',
  { 
    approved: ['Yes', 'Pending'], // IN clause
    fabric: 'Cotton'
  },
  { 
    columns: 'design_id, client, fabric, approved',
    orderBy: 'created_at DESC',
    limit: 20
  }
);

// Example 6: Execute transaction
const result = await executeTransaction(async (client) => {
  // Insert design
  const design = await client.query(
    'INSERT INTO designs (design_id, client) VALUES ($1, $2) RETURNING *',
    ['D002', 'Jane Doe']
  );
  
  // Insert related fabric usage
  await client.query(
    'INSERT INTO fabric_usage (design_id, fabric_type, meters) VALUES ($1, $2, $3)',
    [design.rows[0].id, 'Cotton', 2.5]
  );
  
  return design.rows[0];
});

// Example 7: Raw query execution
const customQuery = await executeQuery(`
  SELECT d.*, f.cost_per_meter 
  FROM designs d
  LEFT JOIN fabric_costs f ON d.fabric = f.fabric_type
  WHERE d.created_at >= $1
`, [new Date('2024-01-01')]);

*/
