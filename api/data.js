import { kv } from '@vercel/kv';

export default async function handler(request, response) {
  // This is a secret password you will set in your Vercel project settings.
  // It prevents unauthorized users from saving data.
  const AUTH_PASSWORD = process.env.EDIT_PASSWORD;

  // Handle a GET request (this is for reading data)
  if (request.method === 'GET') {
    try {
      const scholars = await kv.get('scholars') || [];
      const relations = await kv.get('relations') || [];
      const publications = await kv.get('publications') || {};

      return response.status(200).json({ scholars, relations, publications });
    } catch (error) {
      console.error('KV Read Error:', error);
      return response.status(500).json({ error: 'Could not read from database.' });
    }
  }

  // Handle a POST request (this is for writing/saving data)
  if (request.method === 'POST') {
    const providedPassword = request.headers['x-auth-password'];

    // Check if the provided password is correct
    if (!AUTH_PASSWORD || providedPassword !== AUTH_PASSWORD) {
        return response.status(401).json({ error: 'Unauthorized: Incorrect password.' });
    }
    
    // Get the new data from the request body
    const { scholars, relations, publications } = request.body;
    if (!scholars || !relations || !publications) {
        return response.status(400).json({ error: 'Bad Request: Missing data in request body.' });
    }

    // Save the updated data to the Vercel KV database
    try {
      await kv.set('scholars', scholars);
      await kv.set('relations', relations);
      await kv.set('publications', publications);
      return response.status(200).json({ message: 'Data updated successfully!' });
    } catch (error) {
      console.error('KV Write Error:', error);
      return response.status(500).json({ error: 'Could not write to database.'});
    }
  }

  // If the request method is not GET or POST, it's not allowed
  return response.status(405).json({ error: `Method ${request.method} Not Allowed` });
}