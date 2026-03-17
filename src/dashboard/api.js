// src/dashboard/api.js
import express from 'express'

const router = express.Router()

router.get('/status', (_req, res) => {
  res.json({ ok: true })
})

export default router
