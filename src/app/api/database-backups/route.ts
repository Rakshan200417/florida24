import { NextResponse } from 'next/server';
import { listFolderFiles, deleteFromB2 } from '@/lib/b2Storage';
import { createDatabaseBackup, checkAndRunAutomated24hBackup, enforceBackupRetention } from '@/lib/backupService';

export const runtime = 'nodejs';

// GET: List all database backups stored in Backblaze B2 database-backups/ folder (retains 5 most recent)
export async function GET() {
  try {
    // Automatically evaluate if 24 hours have elapsed since the last backup
    try {
      await checkAndRunAutomated24hBackup();
    } catch (checkErr) {
      console.warn('[database-backups] 24h auto-backup check skipped:', checkErr);
    }

    // Enforce retention limit: delete any backup beyond the 5 most recent from Backblaze B2
    try {
      await enforceBackupRetention(5);
    } catch (retentionErr) {
      console.warn('[database-backups] Retention enforcement skipped:', retentionErr);
    }

    const rawFiles = await listFolderFiles('database-backups');
    const files = rawFiles.filter(f => f.key && !f.key.endsWith('.bzEmpty'));

    // Sort backups from newest to oldest by lastModified or timestamp in filename
    files.sort((a, b) => {
      const timeA = a.lastModified ? new Date(a.lastModified).getTime() : 0;
      const timeB = b.lastModified ? new Date(b.lastModified).getTime() : 0;
      if (timeB !== timeA) return timeB - timeA;
      return b.key.localeCompare(a.key);
    });

    // Enforce maximum 5 backups in the response
    const activeBackups = files.slice(0, 5);

    const backups = activeBackups.map((file, idx) => {
      const parts = file.key.split('/');
      const filename = parts[parts.length - 1];
      const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
      
      const dateStr = file.lastModified
        ? new Date(file.lastModified).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : 'Recent';

      return {
        id: `b2_${idx}_${filename}`,
        filename,
        key: file.key,
        date: dateStr,
        size: `${sizeMB} MB`,
        url: file.url,
        source: 'Backblaze B2',
        status: 'available',
      };
    });

    return NextResponse.json({ success: true, backups }, { status: 200 });
  } catch (error: any) {
    console.error('[database-backups] Failed to list B2 backups:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// POST: Generate a new real MySQL database JSON snapshot and upload it to Backblaze B2 database-backups/
export async function POST() {
  try {
    const backup = await createDatabaseBackup('manual');

    return NextResponse.json({
      success: true,
      message: 'Database snapshot backed up to Backblaze B2 successfully!',
      backup,
    }, { status: 200 });
  } catch (error: any) {
    console.error('[database-backups] Failed to create B2 backup:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// DELETE: Delete a backup from Backblaze B2
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');
    if (!key) {
      return NextResponse.json({ success: false, error: 'Key is required' }, { status: 400 });
    }

    await deleteFromB2(key);
    return NextResponse.json({ success: true, message: `Backup ${key} deleted from Backblaze B2` });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
