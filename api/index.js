require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const mongoose = require("mongoose");
const admin    = require("firebase-admin");

const PORT      = process.env.PORT      || 5000;
const MONGO_URI = process.env.MONGO_URI;
const NODE_ENV  = process.env.NODE_ENV  || "development";

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// ── DB ────────────────────────────────────────────────────
const connectDB = async () => {
  if (mongoose.connection.readyState >= 1) return;
  await mongoose.connect(MONGO_URI);
};
mongoose.connection.on("connected",    () => console.log("✅  MongoDB Connected"));
mongoose.connection.on("disconnected", () => console.log("⚠️   MongoDB Disconnected"));
mongoose.connection.on("error",        (e) => console.error(`❌  MongoDB Error: ${e.message}`));

// ── MODELS ────────────────────────────────────────────────
const userSchema = new mongoose.Schema(
  {
    firebase_uid: { type: String, required: true, unique: true },
    name:         { type: String, required: true, trim: true },
    email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
    role:         { type: String, enum: ["admin", "team_leader", "member"], default: "member" },
    team_id:      { type: mongoose.Schema.Types.ObjectId, ref: "Team", default: null },
    is_verified:  { type: Boolean, default: false },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);
const User = mongoose.model("User", userSchema);

const teamSchema = new mongoose.Schema(
  {
    team_name:      { type: String, required: true, trim: true },
    team_leader_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    members:        [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);
const Team = mongoose.model("Team", teamSchema);

const taskSchema = new mongoose.Schema(
  {
    task_title:       { type: String, required: true, trim: true },
    task_description: { type: String, default: "" },
    status:           { type: String, enum: ["To-Do", "In Progress", "Done", "Review"], default: "To-Do" },
    progress:         { type: Number, min: 0, max: 100, default: 0 },
    priority:         { type: String, enum: ["low", "medium", "high", "urgent"], default: "medium" },
    assigned_to:      { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    team_leader_id:   { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    team_id:          { type: mongoose.Schema.Types.ObjectId, ref: "Team", required: true },
    created_by:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    column_position:  { type: Number, default: 0 },
    due_date:         { type: Date, default: null },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);
taskSchema.pre("save", function (next) {
  if (this.isModified("progress") && this.progress === 100) this.status = "Review";
  next();
});
const Task = mongoose.model("Task", taskSchema);

const taskActivitySchema = new mongoose.Schema(
  {
    task_id:         { type: mongoose.Schema.Types.ObjectId, ref: "Task", required: true },
    user_id:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    previous_status: { type: String, enum: ["To-Do", "In Progress", "Done", "Review", null], default: null },
    new_status:      { type: String, enum: ["To-Do", "In Progress", "Done", "Review"] },
    progress:        { type: Number, default: 0 },
    comment:         { type: String, default: "" },
  },
  { timestamps: { createdAt: "created_at", updatedAt: false } }
);
const TaskActivity = mongoose.model("TaskActivity", taskActivitySchema);

const taskReviewSchema = new mongoose.Schema(
  {
    task_id:       { type: mongoose.Schema.Types.ObjectId, ref: "Task", required: true },
    reviewer_id:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    review_status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    feedback:      { type: String, default: "" },
  },
  { timestamps: { createdAt: "created_at", updatedAt: false } }
);
const TaskReview = mongoose.model("TaskReview", taskReviewSchema);

// ── MIDDLEWARE ────────────────────────────────────────────
const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Missing Authorization header." });
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split("Bearer ")[1]);
    let user = await User.findOne({ firebase_uid: decoded.uid });
    if (!user) {
      user = await User.create({
        firebase_uid: decoded.uid,
        name:         decoded.name || decoded.email.split("@")[0],
        email:        decoded.email,
        is_verified:  decoded.email_verified || false,
      });
    }
    req.user = user;
    next();
  } catch (err) {
    const msg =
      err.code === "auth/id-token-expired" ? "Token expired. Please re-login."  :
      err.code === "auth/id-token-revoked"  ? "Token revoked. Please re-login." :
                                              "Invalid Firebase token.";
    return res.status(401).json({ success: false, message: msg });
  }
};

const logActivity = (taskId, userId, prevStatus, newStatus, progress, comment = "") =>
  TaskActivity.create({ task_id: taskId, user_id: userId, previous_status: prevStatus, new_status: newStatus, progress, comment });

// ── APP ───────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ Fixed: use named params so `next` is never shadowed or dropped
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("DB connection error:", err.message);
    res.status(500).json({ success: false, message: "Database connection failed." });
  }
});

// ── AUTH ──────────────────────────────────────────────────
const authRouter = express.Router();

authRouter.post("/sync", protect, async (req, res) => {
  try {
    const { name, role } = req.body;
    if (name) req.user.name = name;
    if (role && ["admin", "team_leader", "member"].includes(role)) req.user.role = role;
    await req.user.save();
    res.status(200).json({ success: true, user: req.user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

authRouter.get("/me", protect, (req, res) => {
  res.status(200).json({ success: true, user: req.user });
});

// ── TEAMS ─────────────────────────────────────────────────
const teamRouter = express.Router();
teamRouter.use(protect);

teamRouter.get("/", async (req, res) => {
  try {
    const teams = await Team.find({
      $or: [{ team_leader_id: req.user._id }, { members: req.user._id }],
    })
      .populate("team_leader_id", "name email")
      .populate("members", "name email role");
    res.status(200).json({ success: true, count: teams.length, teams });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

teamRouter.post("/", async (req, res) => {
  try {
    const { team_name } = req.body;
    if (!team_name?.trim()) {
      return res.status(400).json({ success: false, message: "team_name is required." });
    }
    const team = await Team.create({
      team_name:      team_name.trim(),
      team_leader_id: req.user._id,
      members:        [req.user._id],
    });
    await User.findByIdAndUpdate(req.user._id, { role: "team_leader", team_id: team._id });
    const populated = await Team.findById(team._id)
      .populate("team_leader_id", "name email")
      .populate("members", "name email role");
    res.status(201).json({ success: true, team: populated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

teamRouter.get("/:id", async (req, res) => {
  try {
    const team = await Team.findById(req.params.id)
      .populate("team_leader_id", "name email")
      .populate("members", "name email role");
    if (!team) return res.status(404).json({ success: false, message: "Team not found." });
    res.status(200).json({ success: true, team });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

teamRouter.patch("/:id/add-member", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, message: "user_id is required." });
    const team = await Team.findById(req.params.id);
    if (!team) return res.status(404).json({ success: false, message: "Team not found." });
    const isLeader = team.team_leader_id.toString() === req.user._id.toString();
    if (!isLeader && req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Only the team leader can add members." });
    }
    await Team.findByIdAndUpdate(req.params.id, { $addToSet: { members: user_id } });
    await User.findByIdAndUpdate(user_id, { team_id: team._id });
    const updated = await Team.findById(req.params.id)
      .populate("team_leader_id", "name email")
      .populate("members", "name email role");
    res.status(200).json({ success: true, team: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── TASKS ─────────────────────────────────────────────────
const taskRouter = express.Router();
taskRouter.use(protect);

taskRouter.get("/", async (req, res) => {
  try {
    const { team_id } = req.query;
    if (!team_id) return res.status(400).json({ success: false, message: "team_id query param required." });
    const team = await Team.findById(team_id);
    if (!team) return res.status(404).json({ success: false, message: "Team not found." });
    const isMember = team.members.some(m => m.toString() === req.user._id.toString());
    const isLeader = team.team_leader_id.toString() === req.user._id.toString();
    if (!isMember && !isLeader && req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "You are not a member of this team." });
    }
    const tasks = await Task.find({ team_id })
      .populate("assigned_to",    "name email")
      .populate("team_leader_id", "name email")
      .populate("created_by",     "name email")
      .sort({ column_position: 1, created_at: -1 });
    res.status(200).json({ success: true, count: tasks.length, tasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

taskRouter.post("/", async (req, res) => {
  try {
    const { task_title, task_description, priority, assigned_to, team_leader_id, due_date, column_position, team_id } = req.body;
    if (!team_id) return res.status(400).json({ success: false, message: "team_id is required." });
    const team = await Team.findById(team_id);
    if (!team) return res.status(404).json({ success: false, message: "Team not found." });
    const isLeader = team.team_leader_id.toString() === req.user._id.toString();
    if (!isLeader && req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Only team leader or admin can create tasks." });
    }
    const task = await Task.create({
      task_title, task_description, priority, assigned_to,
      team_leader_id: team_leader_id || req.user._id,
      team_id, due_date, column_position,
      created_by: req.user._id,
    });
    await logActivity(task._id, req.user._id, null, "To-Do", 0, "Task created");
    res.status(201).json({ success: true, task });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

taskRouter.get("/:id", async (req, res) => {
  try {
    const task = await Task.findById(req.params.id)
      .populate("assigned_to",    "name email role")
      .populate("team_leader_id", "name email")
      .populate("created_by",     "name email");
    if (!task) return res.status(404).json({ success: false, message: "Task not found." });
    res.status(200).json({ success: true, task });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

taskRouter.patch("/:id", async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ success: false, message: "Task not found." });
    const prevStatus = task.status, prevProgress = task.progress;
    ["task_title","task_description","status","progress","priority","assigned_to","column_position","due_date"]
      .forEach(f => { if (req.body[f] !== undefined) task[f] = req.body[f]; });
    await task.save();
    if (prevStatus !== task.status || prevProgress !== task.progress) {
      await logActivity(task._id, req.user._id, prevStatus, task.status, task.progress, req.body.comment || "");
    }
    res.status(200).json({ success: true, task });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

taskRouter.patch("/:id/accept", async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ success: false, message: "Task not found." });
    if (task.status !== "To-Do") return res.status(400).json({ success: false, message: "Only To-Do tasks can be accepted." });
    const prevStatus = task.status;
    task.status      = "In Progress";
    task.assigned_to = req.user._id;
    await task.save();
    await logActivity(task._id, req.user._id, prevStatus, "In Progress", task.progress, "Task accepted");
    res.status(200).json({ success: true, task });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

taskRouter.delete("/:id", async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ success: false, message: "Task not found." });
    const team     = await Team.findById(task.team_id);
    const isLeader = team?.team_leader_id.toString() === req.user._id.toString();
    if (!isLeader && req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Only team leader or admin can delete tasks." });
    }
    await Task.findByIdAndDelete(req.params.id);
    await TaskActivity.deleteMany({ task_id: req.params.id });
    await TaskReview.deleteMany({ task_id: req.params.id });
    res.status(200).json({ success: true, message: "Task deleted." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

taskRouter.get("/:id/activity", async (req, res) => {
  try {
    const activity = await TaskActivity.find({ task_id: req.params.id })
      .populate("user_id", "name email")
      .sort({ created_at: -1 });
    res.status(200).json({ success: true, count: activity.length, activity });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── REVIEWS ───────────────────────────────────────────────
const reviewRouter = express.Router();
reviewRouter.use(protect);

reviewRouter.post("/:taskId", async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId);
    if (!task) return res.status(404).json({ success: false, message: "Task not found." });
    if (task.status !== "Review") return res.status(400).json({ success: false, message: "Task is not in Review." });
    const team     = await Team.findById(task.team_id);
    const isLeader = team?.team_leader_id.toString() === req.user._id.toString();
    if (!isLeader && req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Only team leader or admin can review tasks." });
    }
    const { review_status, feedback } = req.body;
    const review     = await TaskReview.create({ task_id: task._id, reviewer_id: req.user._id, review_status, feedback });
    const prevStatus = task.status;
    if (review_status === "approved") {
      task.status = "Done";
      await task.save();
      await logActivity(task._id, req.user._id, prevStatus, "Done", task.progress, `Approved: ${feedback}`);
    } else if (review_status === "rejected") {
      task.status   = "In Progress";
      task.progress = Math.min(task.progress, 80);
      await task.save();
      await logActivity(task._id, req.user._id, prevStatus, "In Progress", task.progress, `Rejected: ${feedback}`);
    }
    res.status(201).json({ success: true, review, task });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

reviewRouter.get("/:taskId", async (req, res) => {
  try {
    const reviews = await TaskReview.find({ task_id: req.params.taskId })
      .populate("reviewer_id", "name email")
      .sort({ created_at: -1 });
    res.status(200).json({ success: true, count: reviews.length, reviews });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── MOUNT ─────────────────────────────────────────────────
app.use("/api/auth",    authRouter);
app.use("/api/tasks",   taskRouter);
app.use("/api/reviews", reviewRouter);
app.use("/api/teams",   teamRouter);

app.get("/", (req, res) => res.json({ success: true, message: "Jiva Backend API Running 🚀" }));
app.use((req, res) => res.status(404).json({ success: false, message: `${req.originalUrl} not found.` }));
app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));

// ── START (local only) ────────────────────────────────────
if (NODE_ENV !== "production") {
  connectDB().then(() => {
    app.listen(PORT, () => console.log(`🚀  http://localhost:${PORT}`));
  });
}

module.exports = app;
