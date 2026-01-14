import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import * as notesController from '../controllers/notesController';

const router = Router();

// All routes are protected
router.use(authenticate);

// Notes CRUD operations
router.get('/', notesController.getNotes);
router.get('/:id', notesController.getNote);
router.post('/', notesController.createNote);
router.put('/:id', notesController.updateNote);
router.delete('/:id', notesController.deleteNote);

export default router;
