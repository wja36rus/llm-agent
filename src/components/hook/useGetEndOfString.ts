import { getCurrentEnd } from "../utils/getCurrentEnd";

interface IuseGetEndOfStringtstsProps {
  text: string | any;
}
export const useGetEndOfStringtsts = ({
  text,
}: IuseGetEndOfStringtstsProps) => {
  return getCurrentEnd(text);
};
