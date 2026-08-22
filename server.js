require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const twilio = require('twilio');
const crypto = require('crypto');
const os = require('os');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set in your .env file.');
  process.exit(1);
}

const PASS_SIGNING_SECRET = process.env.PASS_SIGNING_SECRET
  || crypto.createHash('sha256').update(`${JWT_SECRET}::pass-signing`).digest('hex');

const PASS_MAX_AGE_SECONDS = 24 * 60 * 60;

function signTokenPass(tokenId, tokenNumber, generatedAt) {
  return crypto
    .createHmac('sha256', PASS_SIGNING_SECRET)
    .update(`${tokenId}:${tokenNumber}:${generatedAt}`)
    .digest('hex')
    .slice(0, 24);
}

// Twilio SMS Setup
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE;
let twilioClient = null;

try {
  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }
} catch (e) {
  console.log('Twilio running in mock mode until credentials are set.');
}

// MySQL Connection Pool
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

db.getConnection()
  .then(conn => {
    console.log('Connected to MySQL Database successfully!');
    conn.release();
  })
  .catch(err => console.error('Database connection failed:', err.message));

const KIOSK_PIN = process.env.KIOSK_PIN || '0000';

function simpleRateLimit(maxRequests, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    let timestamps = hits.get(ip) || [];
    timestamps = timestamps.filter(t => t > windowStart);

    if (timestamps.length >= maxRequests) {
      return res.status(429).json({ error: `Too many attempts. Please wait a moment and try again.` });
    }

    timestamps.push(now);
    hits.set(ip, timestamps);
    next();
  };
}

// Middleware: Staff / Doctor Verification
const verifyStaff = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(403).json({ error: 'Access denied.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err || decoded.role !== 'Doctor') {
      return res.status(403).json({ error: 'Invalid or expired staff session.' });
    }
    req.staff = decoded;
    next();
  });
};

// Middleware: Super Admin Verification
const verifySuperAdmin = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(403).json({ error: 'Access denied: Admin authentication required.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err || decoded.role !== 'SuperAdmin') {
      return res.status(403).json({ error: 'Forbidden: Super-Admin privileges required.' });
    }
    req.admin = decoded;
    next();
  });
};

// Middleware: Kiosk Session Verification
const verifyKiosk = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(403).json({ valid: false, error: 'Kiosk not authenticated. Enter PIN first.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err || decoded.role !== 'Kiosk') {
      return res.status(403).json({ valid: false, error: 'Kiosk session expired.' });
    }
    next();
  });
};

// Kiosk PIN Login
app.post('/api/kiosk/auth', simpleRateLimit(10, 5 * 60 * 1000), (req, res) => {
  const { pin } = req.body;
  if (pin !== KIOSK_PIN) {
    return res.status(401).json({ error: 'Incorrect kiosk PIN.' });
  }
  const token = jwt.sign({ role: 'Kiosk' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

// Dedicated Admin Login Endpoint
app.post('/api/admin/login', simpleRateLimit(5, 10 * 60 * 1000), async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Admin mobile number and password required.' });

    const [rows] = await db.execute(
      `SELECT * FROM staff WHERE phone = ? AND specialty = 'Super Admin'`,
      [phone]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid admin credentials.' });
    }

    const admin = rows[0];
    const match = await bcrypt.compare(password, admin.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid admin credentials.' });
    }

    const token = jwt.sign(
      { staffId: admin.staff_id, name: admin.name, role: 'SuperAdmin' },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({ role: 'SuperAdmin', token, name: admin.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1. Auth: Unified Login (Staff & Patient)
app.post('/api/auth/login', simpleRateLimit(8, 5 * 60 * 1000), async (req, res) => {
  try {
    const { phone, password, hospitalBranch } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required.' });

    const [staff] = await db.execute(
      `SELECT s.*, svc.service_name, svc.counter_number 
       FROM staff s 
       LEFT JOIN services svc ON s.department_id = svc.service_id 
       WHERE s.phone = ? AND s.specialty != 'Super Admin'`,
      [phone]
    );

    if (staff.length > 0) {
      const member = staff[0];
      if (hospitalBranch && member.hospital_branch !== hospitalBranch) {
        return res.status(403).json({
          error: `Access Denied: ${member.name} belongs to ${member.hospital_branch}, not ${hospitalBranch}.`
        });
      }

      if (await bcrypt.compare(password, member.password)) {
        const token = jwt.sign(
          {
            staffId: member.staff_id,
            name: member.name,
            role: 'Doctor',
            specialty: member.specialty,
            branch: member.hospital_branch,
            departmentId: member.department_id
          },
          JWT_SECRET, { expiresIn: '12h' }
        );
        return res.json({
          role: 'Doctor',
          token,
          user: {
            id: member.staff_id,
            name: member.name,
            specialty: member.specialty,
            branch: member.hospital_branch,
            departmentId: member.department_id,
            serviceName: member.service_name || 'Doctor Consultation',
            counterNumber: member.counter_number || 'Counter 3',
            isAvailable: !!member.is_available,
            unavailabilityReason: member.unavailability_reason
          }
        });
      }
    }

    const [users] = await db.execute('SELECT * FROM users WHERE phone = ?', [phone]);
    if (users.length > 0) {
      if (await bcrypt.compare(password, users[0].password)) {
        const token = jwt.sign(
          { userId: users[0].user_id, name: users[0].name, role: 'Patient' },
          JWT_SECRET, { expiresIn: '12h' }
        );
        return res.json({ role: 'Patient', token, user: { id: users[0].user_id, name: users[0].name, phone: users[0].phone } });
      }
    }

    res.status(401).json({ error: 'Invalid phone or password.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Auth: Register Patient
app.post('/api/auth/register', simpleRateLimit(5, 10 * 60 * 1000), async (req, res) => {
  try {
    const { name, phone, password, gender, age, priority } = req.body;
    const hash = await bcrypt.hash(password || '123456', 10);

    const [resDb] = await db.execute(
      `INSERT INTO users (name, phone, gender, age, priority, password) VALUES (?, ?, ?, ?, ?, ?)`,
      [name, phone, gender || 'N/A', age || 0, priority || 'Regular', hash]
    );

    const token = jwt.sign({ userId: resDb.insertId, name, role: 'Patient' }, JWT_SECRET, { expiresIn: '12h' });
    res.status(201).json({ role: 'Patient', token, user: { id: resDb.insertId, name, phone } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Phone number already registered.' });
    res.status(500).json({ error: err.message });
  }
});

// 3. Fetch Doctors for Branch
app.get('/api/doctors/branch', async (req, res) => {
  try {
    const branch = req.query.branch || 'City Hospital (Main Branch)';
    const [doctors] = await db.execute(
      'SELECT staff_id, name, specialty, is_available, unavailability_reason FROM staff WHERE hospital_branch = ? AND department_id = 1',
      [branch]
    );
    res.json(doctors);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. Staff/Doctor: Toggle Availability
app.patch('/api/doctor/availability', verifyStaff, async (req, res) => {
  try {
    const staffId = req.staff.staffId;
    const { isAvailable, reason } = req.body;

    await db.execute(
      `UPDATE staff SET is_available = ?, unavailability_reason = ? WHERE staff_id = ?`,
      [isAvailable ? 1 : 0, reason || null, staffId]
    );

    res.json({
      message: `Status updated to ${isAvailable ? 'Available' : 'Unavailable'}`,
      isAvailable: !!isAvailable,
      reason: reason || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Generate Queue Token (Patient Self-Service)
app.post('/api/tokens/generate', simpleRateLimit(10, 5 * 60 * 1000), async (req, res) => {
  try {
    const { serviceName, userId, hospitalBranch, staffId } = req.body;
    const [services] = await db.execute('SELECT * FROM services WHERE service_name = ?', [serviceName]);
    if (services.length === 0) return res.status(404).json({ error: 'Service department not found.' });

    const service = services[0];
    const branch = hospitalBranch || 'City Hospital (Main Branch)';

    if (staffId && service.service_id === 1) {
      const [docCheck] = await db.execute('SELECT is_available, name FROM staff WHERE staff_id = ?', [staffId]);
      if (docCheck.length > 0 && !docCheck[0].is_available) {
        return res.status(400).json({ error: `${docCheck[0].name} is currently unavailable for consultations.` });
      }
    }

    let query = `
      SELECT COUNT(*) AS count 
      FROM queue_tokens 
      WHERE service_id = ? 
        AND hospital_branch = ? 
        AND status = 'Waiting' 
        AND DATE(created_at) = CURRENT_DATE()`;
    let queryParams = [service.service_id, branch];

    if (staffId && service.service_id === 1) {
      query += ` AND staff_id = ?`;
      queryParams.push(staffId);
    }

    const [waiting] = await db.execute(query, queryParams);
    const peopleAhead = waiting[0].count;

    const [todayCount] = await db.execute(
      `SELECT COUNT(*) AS total_today 
       FROM queue_tokens 
       WHERE service_id = ? AND hospital_branch = ? AND DATE(created_at) = CURRENT_DATE()`,
      [service.service_id, branch]
    );
    const tokenSeq = todayCount[0].total_today + 1;
    const tokenNumber = `A10${tokenSeq}`;
    const estimatedWaitMins = (peopleAhead * service.avg_wait_time) + 2;

    const [insertResult] = await db.execute(
      `INSERT INTO queue_tokens (token_number, service_id, staff_id, user_id, hospital_branch, status, people_ahead) 
       VALUES (?, ?, ?, ?, ?, 'Waiting', ?)`,
      [tokenNumber, service.service_id, staffId || null, userId || null, branch, peopleAhead]
    );

    const tokenId = insertResult.insertId;
    const [createdRows] = await db.execute('SELECT created_at FROM queue_tokens WHERE token_id = ?', [tokenId]);
    const generatedAt = Math.floor(new Date(createdRows[0].created_at).getTime() / 1000);

    res.status(201).json({
      tokenId,
      tokenNumber,
      serviceName: service.service_name,
      counter: service.counter_number,
      hospitalBranch: branch,
      peopleAhead,
      estimatedWaitMins,
      generatedAt,
      passHash: signTokenPass(tokenId, tokenNumber, generatedAt)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. Offline Walk-in Patient Token Creator (Counter 4 & Reception)
app.post('/api/desk/walkin-token', verifyStaff, async (req, res) => {
  try {
    const { name, phone, priority, serviceId, staffId } = req.body;
    const branch = req.staff.branch;

    if (!name || !serviceId) {
      return res.status(400).json({ error: 'Patient name and department service are required.' });
    }

    let userId = null;
    if (phone && phone.trim().length === 10) {
      const [existing] = await db.execute('SELECT user_id FROM users WHERE phone = ?', [phone]);
      if (existing.length > 0) {
        userId = existing[0].user_id;
      } else {
        const defaultHash = await bcrypt.hash('walkin123', 10);
        const [newUser] = await db.execute(
          `INSERT INTO users (name, phone, gender, age, priority, password) VALUES (?, ?, 'N/A', 0, ?, ?)`,
          [name, phone, priority || 'Regular', defaultHash]
        );
        userId = newUser.insertId;
      }
    } else {
      const defaultHash = await bcrypt.hash('walkin123', 10);
      const [newUser] = await db.execute(
        `INSERT INTO users (name, phone, gender, age, priority, password) VALUES (?, NULL, 'N/A', 0, ?, ?)`,
        [name, priority || 'Regular', defaultHash]
      );
      userId = newUser.insertId;
    }

    const [services] = await db.execute('SELECT * FROM services WHERE service_id = ?', [serviceId]);
    if (services.length === 0) return res.status(404).json({ error: 'Selected service not found.' });
    const service = services[0];

    const [todayTokens] = await db.execute(
      `SELECT COUNT(*) AS total_today 
       FROM queue_tokens 
       WHERE service_id = ? AND hospital_branch = ? AND DATE(created_at) = CURRENT_DATE()`,
      [serviceId, branch]
    );
    const tokenSeq = todayTokens[0].total_today + 1;
    const tokenNumber = `A10${tokenSeq}`;

    let waitQuery = `
      SELECT COUNT(*) AS count 
      FROM queue_tokens 
      WHERE service_id = ? AND hospital_branch = ? AND status = 'Waiting' AND DATE(created_at) = CURRENT_DATE()`;
    let waitParams = [serviceId, branch];

    if (staffId && serviceId === 1) {
      waitQuery += ` AND staff_id = ?`;
      waitParams.push(staffId);
    }
    const [waiting] = await db.execute(waitQuery, waitParams);
    const peopleAhead = waiting[0].count;
    const estimatedWaitMins = (peopleAhead * service.avg_wait_time) + 2;

    const [insertResult] = await db.execute(
      `INSERT INTO queue_tokens (token_number, service_id, staff_id, user_id, hospital_branch, status, people_ahead) 
       VALUES (?, ?, ?, ?, ?, 'Waiting', ?)`,
      [tokenNumber, serviceId, staffId || null, userId, branch, peopleAhead]
    );

    const tokenId = insertResult.insertId;
    const generatedAt = Math.floor(Date.now() / 1000);
    const passHash = signTokenPass(tokenId, tokenNumber, generatedAt);

    res.status(201).json({
      tokenId,
      tokenNumber,
      patientName: name,
      priority: priority || 'Regular',
      serviceName: service.service_name,
      counter: service.counter_number,
      hospitalBranch: branch,
      peopleAhead,
      estimatedWaitMins,
      generatedAt,
      passHash
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Role-Locked Staff/Doctor Queue (Resets to 0 at midnight)
app.get('/api/doctor/queue/:serviceId', verifyStaff, async (req, res) => {
  try {
    const staffBranch = req.staff.branch;
    const staffId = req.staff.staffId;
    const serviceId = parseInt(req.params.serviceId);

    let query = `
      SELECT t.token_id, t.token_number, t.status, u.name, u.phone, u.priority, t.created_at 
      FROM queue_tokens t 
      LEFT JOIN users u ON t.user_id = u.user_id 
      WHERE t.service_id = ? 
        AND t.hospital_branch = ? 
        AND t.status IN ('Waiting', 'Called')
        AND DATE(t.created_at) = CURRENT_DATE()`;
    let params = [serviceId, staffBranch];

    if (serviceId === 1) {
      query += ` AND (t.staff_id = ? OR t.staff_id IS NULL)`;
      params.push(staffId);
    }

    query += ` ORDER BY CASE 
      WHEN u.priority = 'Emergency' THEN 1 
      WHEN u.priority IN ('Senior Citizen', 'PwD', 'Pregnant') THEN 2 
      ELSE 3 
    END, t.token_id ASC`;

    const [tokens] = await db.execute(query, params);

    let countQuery = `
      SELECT COUNT(*) AS total 
      FROM queue_tokens 
      WHERE service_id = ? 
        AND hospital_branch = ? 
        AND DATE(created_at) = CURRENT_DATE()`;
    let countParams = [serviceId, staffBranch];

    if (serviceId === 1) {
      countQuery += ` AND (staff_id = ? OR staff_id IS NULL)`;
      countParams.push(staffId);
    }

    const [totalCount] = await db.execute(countQuery, countParams);
    res.json({ tokens, totalIssued: totalCount[0].total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. Chained Token Prescription Workflow
app.post('/api/doctor/tokens/:tokenId/chain-prescribe', verifyStaff, async (req, res) => {
  try {
    const { tokenId } = req.params;
    const { prescribeLab, prescribePharmacy } = req.body;
    const doctorBranch = req.staff.branch;

    const [parentRows] = await db.execute(
      `SELECT token_id, token_number, user_id, hospital_branch FROM queue_tokens WHERE token_id = ?`,
      [tokenId]
    );

    if (parentRows.length === 0) {
      return res.status(404).json({ error: 'Parent token not found.' });
    }

    const parent = parentRows[0];
    const generatedSubTokens = [];

    await db.execute(`UPDATE queue_tokens SET status = 'Completed' WHERE token_id = ?`, [tokenId]);

    if (prescribeLab) {
      const [waitingLab] = await db.execute(
        `SELECT COUNT(*) AS count 
         FROM queue_tokens 
         WHERE service_id = 2 
           AND hospital_branch = ? 
           AND status = 'Waiting' 
           AND DATE(created_at) = CURRENT_DATE()`,
        [doctorBranch]
      );
      const peopleAhead = waitingLab[0].count;
      const subTokenLab = `${parent.token_number}-LAB`;

      await db.execute(
        `INSERT INTO queue_tokens (token_number, service_id, user_id, hospital_branch, status, people_ahead)
         VALUES (?, 2, ?, ?, 'Waiting', ?)`,
        [subTokenLab, parent.user_id, doctorBranch, peopleAhead]
      );

      generatedSubTokens.push({
        service: 'Blood Test / Pathology (Counter 1)',
        tokenNumber: subTokenLab,
        estimatedWait: (peopleAhead * 5) + 2
      });
    }

    if (prescribePharmacy) {
      const [waitingPharm] = await db.execute(
        `SELECT COUNT(*) AS count 
         FROM queue_tokens 
         WHERE service_id = 3 
           AND hospital_branch = ? 
           AND status = 'Waiting' 
           AND DATE(created_at) = CURRENT_DATE()`,
        [doctorBranch]
      );
      const peopleAhead = waitingPharm[0].count;
      const subTokenPharm = `${parent.token_number}-PHARM`;

      await db.execute(
        `INSERT INTO queue_tokens (token_number, service_id, user_id, hospital_branch, status, people_ahead)
         VALUES (?, 3, ?, ?, 'Waiting', ?)`,
        [subTokenPharm, parent.user_id, doctorBranch, peopleAhead]
      );

      generatedSubTokens.push({
        service: 'Medicine Collection (Counter 2)',
        tokenNumber: subTokenPharm,
        estimatedWait: (peopleAhead * 4) + 2
      });
    }

    res.json({
      message: 'Consultation completed and sub-tokens routed successfully!',
      chainedTokens: generatedSubTokens
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Super-Admin Master Analytics (Dynamic Date Range & History Filtering)
app.get('/api/admin/metrics', verifySuperAdmin, async (req, res) => {
  try {
    const { range, date } = req.query;

    let dateCondition = `DATE(created_at) = CURRENT_DATE()`;
    let dateParams = [];

    if (date) {
      dateCondition = `DATE(created_at) = ?`;
      dateParams.push(date);
    } else if (range === 'yesterday') {
      dateCondition = `DATE(created_at) = CURRENT_DATE() - INTERVAL 1 DAY`;
    } else if (range === 'week') {
      dateCondition = `DATE(created_at) >= CURRENT_DATE() - INTERVAL 7 DAY`;
    } else if (range === 'all') {
      dateCondition = `1=1`;
    }

    const [branchStats] = await db.execute(`
      SELECT 
        hospital_branch,
        COUNT(*) AS total_tokens,
        SUM(CASE WHEN status = 'Waiting' THEN 1 ELSE 0 END) AS waiting_count,
        SUM(CASE WHEN status = 'Called' THEN 1 ELSE 0 END) AS serving_count,
        SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) AS completed_count
      FROM queue_tokens
      WHERE ${dateCondition}
      GROUP BY hospital_branch
    `, dateParams);

    const [doctorStats] = await db.execute(`
      SELECT 
        hospital_branch,
        COUNT(*) AS total_doctors,
        SUM(CASE WHEN is_available = 1 THEN 1 ELSE 0 END) AS available_doctors,
        SUM(CASE WHEN is_available = 0 THEN 1 ELSE 0 END) AS unavailable_doctors
      FROM staff
      WHERE specialty != 'Super Admin'
      GROUP BY hospital_branch
    `);

    const [triageStats] = await db.execute(`
      SELECT 
        COALESCE(u.priority, 'Regular') AS priority,
        COUNT(t.token_id) AS count
      FROM queue_tokens t
      LEFT JOIN users u ON t.user_id = u.user_id
      WHERE ${dateCondition.replace(/created_at/g, 't.created_at')}
      GROUP BY u.priority
    `, dateParams);

    const [doctorRoster] = await db.execute(`
      SELECT name, specialty, hospital_branch, is_available, unavailability_reason
      FROM staff
      WHERE specialty != 'Super Admin'
      ORDER BY hospital_branch, is_available DESC
    `);

    res.json({
      branches: branchStats,
      doctors: doctorStats,
      triage: triageStats,
      roster: doctorRoster
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Hourly Crowd Analytics
app.get('/api/doctor/analytics/crowd', verifyStaff, async (req, res) => {
  try {
    const staffBranch = req.staff.branch;
    const [hourlyData] = await db.execute(
      `SELECT HOUR(created_at) as hour, COUNT(*) as count 
       FROM queue_tokens 
       WHERE hospital_branch = ? AND DATE(created_at) = CURRENT_DATE() 
       GROUP BY HOUR(created_at) 
       ORDER BY hour ASC`,
      [staffBranch]
    );
    res.json(hourlyData);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 11. Update Token Status & Twilio SMS Alert
app.patch('/api/doctor/tokens/:tokenId', verifyStaff, async (req, res) => {
  try {
    const { status } = req.body;
    await db.execute(`UPDATE queue_tokens SET status = ? WHERE token_id = ?`, [status, req.params.tokenId]);

    if (status === 'Called') {
      const [tokenInfo] = await db.execute(
        `SELECT t.token_number, u.phone FROM queue_tokens t LEFT JOIN users u ON t.user_id = u.user_id WHERE t.token_id = ?`,
        [req.params.tokenId]
      );

      if (tokenInfo.length > 0 && tokenInfo[0].phone) {
        console.log(`[SMS ALERT SENT] To: ${tokenInfo[0].phone} | Token ${tokenInfo[0].token_number} called.`);
        if (twilioClient && TWILIO_PHONE) {
          twilioClient.messages.create({
            body: `🚨 OPD Alert: Token ${tokenInfo[0].token_number} is called! Please proceed to your counter immediately.`,
            from: TWILIO_PHONE,
            to: `+91${tokenInfo[0].phone}`
          }).catch(err => {
            console.log('SMS dispatch notice:', err.message);
          });
        }
      }
    }

    res.json({ message: `Token updated to ${status}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 12. Offline Pass Verification (Kiosk Endpoint)
app.post('/api/tokens/verify', verifyKiosk, async (req, res) => {
  try {
    const { tokenId, tokenNumber, passHash, generatedAt } = req.body;
    if (!tokenId || !tokenNumber || !passHash || !generatedAt) {
      return res.status(400).json({ valid: false, error: 'Malformed or unreadable pass.' });
    }

    const expectedHash = signTokenPass(tokenId, tokenNumber, generatedAt);
    if (expectedHash !== passHash) {
      return res.status(400).json({ valid: false, error: 'This pass failed verification (tampered signature).' });
    }

    const ageSeconds = Math.floor(Date.now() / 1000) - generatedAt;
    if (ageSeconds > PASS_MAX_AGE_SECONDS) {
      return res.status(400).json({ valid: false, error: 'This pass has expired (older than 24 hours).' });
    }

    const [rows] = await db.execute(
      `SELECT t.token_id, t.token_number, t.status, t.hospital_branch, t.checked_in_at,
              s.service_name, s.counter_number, u.name AS patient_name
       FROM queue_tokens t
       LEFT JOIN services s ON t.service_id = s.service_id
       LEFT JOIN users u ON t.user_id = u.user_id
       WHERE t.token_id = ?`,
      [tokenId]
    );
    if (rows.length === 0) return res.status(404).json({ valid: false, error: 'Token not found in system.' });

    const t = rows[0];
    const alreadyCheckedIn = !t.checked_in_at;

    if (!alreadyCheckedIn) {
      await db.execute(`UPDATE queue_tokens SET checked_in_at = NOW() WHERE token_id = ?`, [tokenId]);
    }

    res.json({
      valid: true,
      tokenId: t.token_id,
      tokenNumber: t.token_number,
      status: t.status,
      patientName: t.patient_name || 'Guest',
      serviceName: t.service_name,
      counter: t.counter_number,
      hospitalBranch: t.hospital_branch,
      alreadyCheckedIn
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 13. TV Display Board Feed
app.get('/api/tokens/board', async (req, res) => {
  try {
    const branch = req.query.branch || 'City Hospital (Main Branch)';
    const serviceName = req.query.service || null;

    let calledQuery = `
      SELECT t.token_id, t.token_number, t.status, s.service_name, s.counter_number
      FROM queue_tokens t
      LEFT JOIN services s ON t.service_id = s.service_id
      WHERE t.hospital_branch = ? 
        AND t.status = 'Called'
        AND DATE(t.created_at) = CURRENT_DATE()`;
    let calledParams = [branch];

    if (serviceName) {
      calledQuery += ` AND s.service_name = ?`;
      calledParams.push(serviceName);
    }
    calledQuery += ` ORDER BY t.token_id DESC LIMIT 10`;

    const [calledTokens] = await db.execute(calledQuery, calledParams);

    let waitingQuery = `
      SELECT s.service_name, s.counter_number, COUNT(*) AS waiting_count
      FROM queue_tokens t
      LEFT JOIN services s ON t.service_id = s.service_id
      WHERE t.hospital_branch = ? 
        AND t.status = 'Waiting'
        AND DATE(t.created_at) = CURRENT_DATE()`;
    let waitingParams = [branch];

    if (serviceName) {
      waitingQuery += ` AND s.service_name = ?`;
      waitingParams.push(serviceName);
    }
    waitingQuery += ` GROUP BY s.service_name, s.counter_number`;

    const [waitingCounts] = await db.execute(waitingQuery, waitingParams);
    res.json({ called: calledTokens, waiting: waitingCounts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Smart Queue Server running on http://localhost:${PORT}`);
});