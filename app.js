require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const app = express();
const server = http.createServer(app);
const io = new Server(server);


const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || 'cardiac_sos_secret_2024';

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    clientPromise: mongoose.connection.asPromise().then(conn => conn.getClient()),
    touchAfter: 24 * 3600
  }),
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);


io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session.userId) {
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
}

mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.warn('MongoDB not available, running in demo mode:', err.message));


const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, enum: ['patient', 'responder', 'admin'], default: 'patient' },
  isPremium: { type: Boolean, default: false },
  bloodGroup: String,
  allergies: String,
  medications: String,
  conditions: String,
  emergencyContact: String,
  emergencyPhone: String,
  createdAt: { type: Date, default: Date.now }
});

const alertSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  userName: String,
  riskScore: Number,
  heartRate: Number,
  spo2: Number,
  hrv: Number,
  symptoms: [String],
  lat: Number,
  lng: Number,
  status: { type: String, default: 'active' },
  createdAt: { type: Date, default: Date.now }
});

const premiumRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  problem: String,
  facilityType: String,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const PremiumRequest = mongoose.model('PremiumRequest', premiumRequestSchema);
const User = mongoose.model('User', userSchema);
const Alert = mongoose.model('Alert', alertSchema);

const twilio = require('twilio');
const twilioClient = new twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.post('/api/alert', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select('-password');
    const { riskScore, heartRate, spo2, symptoms, lat, lng } = req.body;

    const alert = new Alert({
      userId: req.session.userId,
      userName: user.name,
      riskScore, heartRate, spo2, symptoms, lat, lng
    });
    await alert.save();

    if (user.emergencyPhone) {
      try {
        await twilioClient.calls.create({
          twiml: `<Response>
                    <Say voice="polly.Russell">
                      Emergency Alert for ${user.name}. 
                      Current heart rate is ${heartRate} beats per minute. 
                      Oxygen level is ${spo2} percent. 
                      Symptoms reported: ${symptoms.join(', ') || 'none'}.
                      Please check the Cardiac S O S dashboard immediately.
                    </Say>
                  </Response>`,
          to: user.emergencyPhone,
          from: process.env.TWILIO_PHONE_NUMBER
        });
        console.log(`Emergency call initiated to ${user.emergencyPhone}`);
      } catch (twilioErr) {
        console.error('Twilio Call Failed:', twilioErr.message);
      }
    }

    io.emit('new_alert', { ...alert.toObject(), userName: user.name });

    res.json({ success: true, alertId: alert._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/premium/service-request', requireAuth, async (req, res) => {
  try {
    const { problem, facilityType } = req.body;

    // IMPORTANT: You must create an instance of the model
    const newRequest = new PremiumRequest({
      userId: req.session.userId,
      problem: problem,
      facilityType: facilityType
    });

    await newRequest.save(); // This sends it to the DB

    res.json({
      success: true,
      message: "Request received. A coordinator will contact you shortly."
    });
  } catch (err) {
    console.error("Premium Save Error:", err);
    res.status(500).json({ error: "Failed to save request." });
  }
});

// 1. Serve the appointments page to responders
app.get('/responder/appointments', requireAuth, (req, res) => {
  if (req.session.userRole !== 'responder') return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'pages', 'appointments.html'));
});

// 2. API to fetch all premium requests for the responder
app.get('/api/responder/requests', requireAuth, async (req, res) => {
  try {
    if (req.session.userRole !== 'responder') return res.status(403).send("Unauthorized");

    // Fetch requests and join with user names
    const requests = await PremiumRequest.find({ status: 'pending' })
      .sort({ createdAt: -1 })
      .lean();

    const populated = await Promise.all(requests.map(async (r) => {
      const user = await User.findById(r.userId).select('name');
      return { ...r, userName: user?.name || "Unknown User" };
    }));

    res.json(populated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

let csvData = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, 'data', 'heart_data.txt'), 'utf8');
  const cleanJson = raw.replace(/""/g, '"').replace(/^"/, '').replace(/"$/, '');
  const parsedData = JSON.parse(cleanJson);

  if (parsedData.sport && Array.isArray(parsedData.sport)) {
    csvData = parsedData.sport.map((entry, index) => {

      const isActive = entry.STEPS > 500;
      return {
        heart_rate: isActive ? 95 + (index % 15) : 70 + (index % 10),
        spo2: 98 - (index % 3),
        hrv: isActive ? 25 + (index % 5) : 45 + (index % 10),
        rrInterval: isActive ? 650 + (index * 5) : 830 + (index * 2),
        ecg_value: (0.15 + Math.random() * 0.5).toFixed(2),
        steps: entry.STEPS,
        calories: entry.CALORY
      };
    });
  }
  console.log(`Successfully loaded ${csvData.length} records from file`);
} catch (e) {
  console.warn('⚠️ File load failed:', e.message);
  csvData = [];
}


app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email already registered' });
    const hashed = await bcrypt.hash(password, 10);
    const user = new User({ name, email, password: hashed, role: role || 'patient' });
    await user.save();
    req.session.userId = user._id;
    req.session.userName = user.name;
    req.session.userRole = user.role;
    res.json({ success: true, name: user.name, role: user.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Invalid credentials' });
    req.session.userId = user._id;
    req.session.userName = user.name;
    req.session.userRole = user.role;
    res.json({ success: true, name: user.name, role: user.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual Emergency Call Trigger
app.post('/api/help-call', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);

    if (!user || !user.emergencyPhone) {
      return res.status(400).json({ error: "No emergency contact found." });
    }

    // Initiate the Twilio Call
    await twilioClient.calls.create({
      twiml: `
        <Response>
          <Say voice="polly.Russell" speed="0.9">
            Emergency Alert. Your contact, ${user.name}, has requested immediate help through the Cardiac S O S voice system. 
            Please check on them right now. I repeat, ${user.name} needs assistance.
          </Say>
        </Response>`,
      to: user.emergencyPhone,
      from: process.env.TWILIO_PHONE_NUMBER
    });

    console.log(`Voice-triggered help call sent to ${user.emergencyPhone}`);
    res.json({ success: true, message: "Call initiated." });
  } catch (err) {
    console.error("Twilio Voice Error:", err);
    res.status(500).json({ error: "Failed to place call." });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select('-password');
    res.json(user);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const { bloodGroup, allergies, medications, conditions, emergencyContact, emergencyPhone } = req.body;
    await User.findByIdAndUpdate(req.session.userId, {
      bloodGroup, allergies, medications, conditions, emergencyContact, emergencyPhone
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post('/api/risk', requireAuth, async (req, res) => {
  try {
    const { heartRate, spo2, hrv, symptoms } = req.body;
    const prompt = `
      Analyze these cardiac vitals: HR ${heartRate} BPM, SpO2 ${spo2}%, HRV ${hrv}ms.
      Symptoms: ${(symptoms || []).join(', ') || 'none'}.
      Return ONLY a JSON object, no markdown:
      {"score": 0-100, "level": "NORMAL" | "WARNING" | "EMERGENCY"}
    `;
    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    res.json(JSON.parse(text));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post('/api/ai-analyze', requireAuth, async (req, res) => {
  try {
    const { heartRate, spo2, hrv, symptoms, trend } = req.body;

    const prompt = `
      You are a cardiac monitoring AI. Analyze these patient vitals:
      - Heart Rate: ${heartRate} BPM
      - SpO2: ${spo2}%
      - HRV: ${hrv}ms
      - Symptoms: ${(symptoms || []).join(', ') || 'None reported'}
      - Recent HR Trend: ${(trend || []).join(', ')}

      Provide a high-precision medical summary.
      Return ONLY a JSON object with no markdown fences:
      {
        "assessment": "1-2 sentence clinical observation",
        "risk_level": "Low" | "Moderate" | "High" | "Critical",
        "action_steps": ["Step 1", "Step 2"]
      }
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    res.json(JSON.parse(text));
  } catch (err) {
    console.error('Gemini Error:', err);
    res.status(500).json({ error: 'AI analysis failed.' });
  }
});


app.post('/api/analyze-vitals', requireAuth, async (req, res) => {
  try {
    const { heartRate, spo2, hrv, symptoms } = req.body;

    const prompt = `
      Analyze the following cardiac vitals and return ONLY a JSON object, no markdown.
      Vitals: Heart Rate: ${heartRate} bpm, SpO2: ${spo2}%, HRV: ${hrv}ms.
      Symptoms: ${(symptoms || []).join(', ') || 'None'}.
      Format:
      {
        "score": 0-100,
        "level": "NORMAL" | "WARNING" | "EMERGENCY",
        "analysis": "Brief 1-sentence medical explanation"
      }
    `;

    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, '').trim();
    res.json(JSON.parse(text));
  } catch (err) {
    console.error('Gemini Error:', err);
    res.status(500).json({ error: 'AI Analysis failed' });
  }
});


app.get('/api/csv-data', requireAuth, (req, res) => {
  res.json(csvData);
});


app.post('/api/alert', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).select('-password');
    const { riskScore, heartRate, spo2, hrv, symptoms, lat, lng } = req.body;
    const alert = new Alert({
      userId: req.session.userId,
      userName: user.name,
      riskScore, heartRate, spo2, hrv, symptoms, lat, lng,
      status: 'active'
    });
    await alert.save();
    io.emit('new_alert', {
      id: alert._id,
      userName: user.name,
      riskScore, heartRate, spo2, hrv, symptoms, lat, lng,
      bloodGroup: user.bloodGroup,
      allergies: user.allergies,
      medications: user.medications,
      conditions: user.conditions,
      createdAt: alert.createdAt
    });
    res.json({ success: true, alertId: alert._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/alerts', requireAuth, async (req, res) => {
  try {
    const alerts = await Alert.find({ status: 'active' })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    const populatedAlerts = await Promise.all(alerts.map(async (alert) => {
      const user = await User.findById(alert.userId).select('bloodGroup allergies medications conditions');
      return {
        ...alert,
        bloodGroup: user?.bloodGroup,
        allergies: user?.allergies,
        medications: user?.medications,
        conditions: user?.conditions
      };
    }));

    res.json(populatedAlerts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/alert/:id/resolve', requireAuth, async (req, res) => {
  try {
    await Alert.findByIdAndUpdate(req.params.id, { status: 'resolved' });
    io.emit('alert_resolved', { id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Premium Status
app.get('/api/premium/status', requireAuth, async (req, res) => {
  const user = await User.findById(req.session.userId);
  res.json({ isPremium: user.isPremium });
});

// Mock Subscription Route (To simulate buying)
app.post('/api/premium/subscribe', requireAuth, async (req, res) => {
  await User.findByIdAndUpdate(req.session.userId, { isPremium: true });
  res.json({ success: true });
});

// Handle Premium Service Request
app.post('/api/premium/service-request', requireAuth, async (req, res) => {
  const { problem, facilityType } = req.body;
  // Here you would save this to a new 'PremiumRequests' collection or send an email
  console.log(`Premium request from ${req.session.userId}: ${problem}`);
  res.json({ success: true, message: "Request received. A medical coordinator will contact you." });
});

// Serve the page
app.get('/premium', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'premium.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'dashboard.html'));
});

app.get('/responder', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'responder.html'));
});

app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'profile.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pages', 'register.html'));
});


io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('vitals_update', (data) => {
    const { heartRate, spo2, hrv, symptoms } = data;

    let score = 0;
    if (heartRate > 120 || heartRate < 50) score += 30;
    else if (heartRate > 100 || heartRate < 60) score += 15;
    if (spo2 < 90) score += 40;
    else if (spo2 < 94) score += 20;
    if (hrv < 10) score += 20;
    else if (hrv < 20) score += 10;
    if (symptoms && symptoms.length > 0) score += symptoms.length * 5;
    score = Math.min(score, 100);

    const level = score >= 70 ? 'EMERGENCY' : score >= 40 ? 'WARNING' : 'NORMAL';
    socket.emit('risk_update', { score, level, ...data });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Cardiac SOS running on http://localhost:3000`)
});
