import { plainToInstance } from 'class-transformer';
import { RegisterDto } from '../../resources/auth/dto/register.dto';
import { VerifyEmailDto } from '../../resources/auth/dto/verify-email.dto';
import { normalizeEmail } from './normalize-email';

describe('normalizeEmail', () => {
  it('trims surrounding whitespace and lowercases', () => {
    expect(normalizeEmail('  John.Doe@Example.COM  ')).toBe(
      'john.doe@example.com',
    );
  });

  it('leaves an already-normalised email unchanged', () => {
    expect(normalizeEmail('a@b.com')).toBe('a@b.com');
  });
});

describe('@NormalizeEmail (DTO transform)', () => {
  it('normalises the email on RegisterDto during class-transformer transform', () => {
    const dto = plainToInstance(RegisterDto, {
      email: '  John@X.Com ',
      password: 'sup3rsecret',
      name: 'John',
    });
    expect(dto.email).toBe('john@x.com');
  });

  it('normalises the email on VerifyEmailDto and leaves the code untouched', () => {
    const dto = plainToInstance(VerifyEmailDto, {
      email: 'CODER@Mail.Io',
      code: '123456',
    });
    expect(dto.email).toBe('coder@mail.io');
    expect(dto.code).toBe('123456');
  });

  it('leaves a non-string email value untouched (validation then rejects it)', () => {
    const dto = plainToInstance(RegisterDto, {
      email: 123 as unknown as string,
      password: 'sup3rsecret',
      name: 'John',
    });
    expect(dto.email).toBe(123 as unknown as string);
  });
});
