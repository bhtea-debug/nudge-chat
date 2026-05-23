import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { put } from '@vercel/blob';
import { nanoid } from 'nanoid';

// Vercel serverless filesystems are read-only outside /tmp, and /tmp is ephemeral
// and not served by the static handler — the old `writeFile('public/uploads/...')`
// crashed every upload with EROFS in production. Use Vercel Blob instead.
//
// Setup required in Vercel: Storage → Create Blob Store → connect to project.
// That injects BLOB_READ_WRITE_TOKEN automatically. Without it we 501 rather
// than pretending to succeed.
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();

    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return NextResponse.json(
        { error: 'File uploads not configured. Enable Vercel Blob storage for this project.' },
        { status: 501 }
      );
    }

    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const messageId = formData.get('messageId') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '';
    const blobPath = `chat/${user.id}/${nanoid()}${ext}`;

    const blob = await put(blobPath, file, {
      access: 'public',
      contentType: file.type || 'application/octet-stream',
      addRandomSuffix: false,
    });

    if (messageId) {
      const id = nanoid();
      await db.execute({
        sql: `INSERT INTO chat_files (id, message_id, user_id, filename, file_url, file_size, mime_type)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [id, messageId, user.id, file.name, blob.url, file.size, file.type],
      });
    }

    return NextResponse.json({
      url: blob.url,
      filename: file.name,
      size: file.size,
      mimeType: file.type,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Upload error:', error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
