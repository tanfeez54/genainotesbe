

async function test() {
  const apiKey = '657096f6-c400-47a7-9401-48b2cf57e4ec';
  const goodsenderUrl = 'https://api.goodsender.com/v1/emails/send';
  
  const emailPayload = {
    from: { email: 'ta2nzeem@gmail.com', name: 'NoteGen AI' },
    to: [{ email: 'ta2nzeem@gmail.com' }],
    subject: 'Test Code',
    markdown_content: `test`
  };

  const response = await fetch(goodsenderUrl, {
    method: 'POST',
    headers: {
      'Authorization': `${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(emailPayload)
  });

  console.log(response.status);
  const text = await response.text();
  console.log(text);
}
test();
