import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { nanoid } from 'nanoid';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const messageId = formData.get('messageId') as string;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // For production, use Vercel Blob or R2
    // For now, save to public/uploads
    const uploadDir = path.join(process.cwd(), 'public', 'uploads');
    await mkdir(uploadDir, { recursive: true });

    const ext = path.extname(file.name);
    const filename = `${nanoid()}${ext}`;
    const filePath = path.join(uploadDir, filename);

    const bytes = await file.arrayBuffer();
    await writeFile(filePath, Buffer.from(bytes));

    const fileUrl = `/uploads/${filename}`;

    if (messageId) {
      const id = nanoid();
      await db.execute({
        sql: `INSERT INTO chat_files (id, message_id, user_id, filename, file_url, file_size, mime_type)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [id, messageId, user.id, file.name, fileUrl, file.size, file.type],
      });
    }

    return NextResponse.json({ url: fileUrl, filename: file.name, size: file.size, mimeType: file.type });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Upload error:', error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
