import mongoose from 'mongoose';
import Project from '../models/Project';
import Task from '../models/Task';
import dotenv from 'dotenv';

dotenv.config();

async function updateProjects() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || '');
    console.log('Connected to MongoDB\n');

    const projects = await Project.find({});
    console.log('Total projects:', projects.length);
    console.log('\n=== Current Projects ===');

    projects.forEach((project: any) => {
      console.log('\n-----------------------------------');
      console.log('Name:', project.name);
      console.log('ID:', project._id);
      console.log('Columns:', project.columns?.length || 0);
      if (project.columns) {
        project.columns.forEach((col: any) => {
          console.log('  -', col.title, '(id:', col.id + ')');
        });
      }
    });

    // Find "Pro 1" project
    const pro1 = projects.find((p: any) => p.name === 'Pro 1');

    if (pro1) {
      console.log('\n\n=== Updating Pro 1 to Standard Template ===');
      console.log('Current columns:', pro1.columns?.map((c: any) => c.title).join(', '));

      // Get old column IDs for task migration
      const oldColumns = pro1.columns || [];

      // Set standard columns
      pro1.columns = [
        { id: 'todo', title: 'To Do', color: '#6B7280', order: 0 },
        { id: 'in-progress', title: 'In Progress', color: '#3B82F6', order: 1 },
        { id: 'completed', title: 'Completed', color: '#10B981', order: 2 }
      ];

      await pro1.save();
      console.log('✓ Updated Pro 1 columns to:', pro1.columns.map((c: any) => c.title).join(', '));

      // Migrate tasks to new columns
      const tasks = await Task.find({ projectId: pro1._id });
      console.log(`\nFound ${tasks.length} tasks to migrate`);

      if (tasks.length > 0) {
        // Map old column IDs to new ones
        const columnMapping: { [key: string]: string } = {};

        oldColumns.forEach((oldCol: any) => {
          const title = oldCol.title.toLowerCase();
          if (title.includes('todo') || title.includes('to do') || title === 'todo') {
            columnMapping[oldCol.id] = 'todo';
          } else if (title.includes('progress') || title.includes('doing')) {
            columnMapping[oldCol.id] = 'in-progress';
          } else if (title.includes('done') || title.includes('complete')) {
            columnMapping[oldCol.id] = 'completed';
          } else {
            // Default: put in first column (To Do)
            columnMapping[oldCol.id] = 'todo';
          }
        });

        console.log('\nColumn Mapping:', columnMapping);

        for (const task of tasks) {
          const oldListId = task.listId || task.status;
          const newListId = columnMapping[oldListId] || 'todo';

          if (oldListId !== newListId) {
            task.listId = newListId;
            task.status = newListId;
            await task.save();
            console.log(`  - Updated task "${task.title}": ${oldListId} → ${newListId}`);
          }
        }

        console.log('\n✓ Task migration complete!');
      }
    } else {
      console.log('\n\n⚠ Project "Pro 1" not found');
      console.log('Available projects:', projects.map((p: any) => p.name).join(', '));
    }

    await mongoose.connection.close();
    console.log('\n\nDatabase connection closed');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

updateProjects();
